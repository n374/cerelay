/**
 * Python FUSE daemon 脚本（fusepy）。
 * 嵌入模式与 pty-host-script.ts 完全一致：
 *   - 作为 TypeScript 字符串常量导出
 *   - 运行时写入临时文件后执行
 *   - 通过 stdin/stdout JSON line 与 Server Node.js 通信
 *   - 通过 fd 3 控制管道接收 shutdown 命令
 *
 * 环境变量：
 *   CERELAY_FUSE_MOUNT_POINT  — 挂载点目录
 *   CERELAY_FUSE_CONTROL_FD   — 控制管道 fd（默认 3）
 *   CERELAY_FUSE_ROOTS        — JSON 字符串，虚拟根映射 {"home-claude": "/real/path", ...}
 *   CERELAY_FUSE_READY_FILE   — 就绪标记文件路径
 */
export const PYTHON_FUSE_HOST_SCRIPT = String.raw`
import base64
import bisect
import errno
import json
import os
import stat as stat_mod
import sys
import threading
import time
import traceback

try:
    from fuse import FUSE, FuseOSError, Operations
except ImportError:
    try:
        from fusepy import FUSE, FuseOSError, Operations
    except ImportError:
        sys.stderr.write("fusepy not installed. Install with: pip3 install fusepy\n")
        sys.exit(1)

# ============================================================
# 配置
# ============================================================

MOUNT_POINT = os.environ["CERELAY_FUSE_MOUNT_POINT"]
CONTROL_FD = int(os.environ.get("CERELAY_FUSE_CONTROL_FD", "3"))
ROOTS = json.loads(os.environ.get("CERELAY_FUSE_ROOTS", "{}"))
ANCESTOR_ROOT_ALLOWED_FILES = frozenset(["CLAUDE.md", "CLAUDE.local.md"])
READY_FILE = os.environ.get("CERELAY_FUSE_READY_FILE", "")
# Shadow files: FUSE 内路径 → 本地真实文件路径（如 hook injection 的 settings.local.json）
# 这些文件由 FUSE daemon 直接从本地读取，不代理到 Client
SHADOW_FILES = json.loads(os.environ.get("CERELAY_FUSE_SHADOW_FILES", "{}"))

# reqId 计数器
_req_counter = 0
_req_lock = threading.Lock()

# 待处理请求: reqId → threading.Event + result dict
_pending = {}
_pending_lock = threading.Lock()

# stdout 写锁
_stdout_lock = threading.Lock()

# ============================================================
# 缓存
# ============================================================

class NegativeCache:
    def __init__(self):
        self._sorted = []
        self._set = set()

    def _normalize(self, path):
        if not path:
            return ""
        normalized = os.path.normpath(path)
        if normalized == ".":
            return ""
        return normalized

    def contains(self, path):
        """路径本身或任意父前缀已知 ENOENT 时命中。caller 持有外层锁。"""
        normalized = self._normalize(path)
        if not normalized:
            return False
        idx = bisect.bisect_right(self._sorted, normalized)
        if idx <= 0:
            return False
        candidate = self._sorted[idx - 1]
        return normalized == candidate or normalized.startswith(candidate + "/")

    def put(self, path):
        """插入 missing path；若父前缀已存在则跳过，并吸收子条目。caller 持有外层锁。"""
        normalized = self._normalize(path)
        if not normalized:
            return
        idx = bisect.bisect_right(self._sorted, normalized)
        if idx > 0:
            candidate = self._sorted[idx - 1]
            if normalized == candidate or normalized.startswith(candidate + "/"):
                return

        prefix = normalized + "/"
        start = bisect.bisect_left(self._sorted, normalized)
        end = start
        while end < len(self._sorted):
            candidate = self._sorted[end]
            if candidate == normalized or candidate.startswith(prefix):
                end += 1
                continue
            break

        for candidate in self._sorted[start:end]:
            self._set.discard(candidate)
        del self._sorted[start:end]
        bisect.insort(self._sorted, normalized)
        self._set.add(normalized)

    def invalidate_prefix(self, prefix):
        """清理 prefix 的祖先 missing 记录，以及 prefix 下的子记录。caller 持有外层锁。"""
        normalized = self._normalize(prefix)
        if not normalized:
            return

        current = normalized
        while current and current != "/":
            if current in self._set:
                self._set.discard(current)
                self._sorted.remove(current)
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent

        child_prefix = normalized + "/"
        start = bisect.bisect_left(self._sorted, normalized)
        end = start
        while end < len(self._sorted):
            candidate = self._sorted[end]
            if candidate == normalized or candidate.startswith(child_prefix):
                end += 1
                continue
            break
        for candidate in self._sorted[start:end]:
            self._set.discard(candidate)
        del self._sorted[start:end]

    def clear(self):
        self._sorted.clear()
        self._set.clear()

class Cache:
    def __init__(self):
        self._lock = threading.Lock()
        # 运行时 cache：getattr 等 op 第一次穿透 client 后落缓存，TTL 限制以
        # 应对 client 端文件被外部改动的情况（除 client cache_task watcher
        # 命中的 invalidate 外，本地兜底 TTL 也很有意义）。
        self._stat = {}     # path → (timestamp, stat_dict)
        self._readdir = {}  # path → (timestamp, entries)
        self._read = {}     # path → (timestamp, bytes)
        # snapshot 启动预填层：永久有效，不被 TTL 清掉。snapshot 已经反映了启动
        # 那一刻 client 的真实状态，TTL 后失效会让真实存在的文件也穿透 client
        # （实测启动 20s 后 skills/bytedcli-tce-single-cluster-deploy 这种深度
        # 浅、肯定存在的 path 出现 perforation，就是 _stat TTL 到期的结果）。
        self._stat_perm = {}    # path → stat_dict（无时间戳）
        self._readdir_perm = {} # path → entries
        self._read_perm = {}    # path → bytes
        # P0-1: snapshot 启动时预填的"已知 ENOENT path"（broken symlink 等）。
        # 永久有效（无 TTL）：snapshot 已经把 readdir 列出但 stat 失败的子项标好了。
        self._negative_perm = NegativeCache()
        self._stat_ttl = 10.0
        self._readdir_ttl = 10.0
        self._read_ttl = 10.0
        self._read_max_size = 256 * 1024  # 256KB
        # 诊断计数器：区分 "key 不在 cache" 和 "在但 TTL 过期"，让用户判断 snapshot
        # 是不完整还是只是被 TTL 限制。
        self.stat_hit = 0
        self.stat_miss_absent = 0   # 完全不在 _stat 字典里
        self.stat_miss_expired = 0  # 在但 TTL 过期
        self.readdir_hit = 0
        self.readdir_miss_absent = 0
        self.readdir_miss_expired = 0
        self.read_hit = 0
        self.read_miss_absent = 0
        self.read_miss_expired = 0
        # 负缓存命中计数：分别统计 snapshot 预填（perm）和运行时学到的（runtime）
        self.negative_hit_perm = 0
        self.negative_hit_runtime = 0
        self.negative_recorded = 0
        # 抽样未命中的 path（区分缺失 vs 过期），帮诊断"为什么没命中"
        self.miss_samples = []  # list of (kind, reason, path)
        self._miss_sample_cap = 40

    def _record_miss_sample(self, kind, reason, path):
        if len(self.miss_samples) < self._miss_sample_cap:
            self.miss_samples.append((kind, reason, path))

    def is_negative(self, path):
        """ENOENT 命中判断。返回 True 时 caller 应该直接抛 ENOENT，不发 RPC。"""
        with self._lock:
            if self._negative_perm.contains(path):
                self.negative_hit_perm += 1
                return True
        return False

    def put_negative(self, path):
        """运行时记录 ENOENT，使用前缀负缓存持久到显式失效。"""
        with self._lock:
            self._negative_perm.put(path)
            self.negative_recorded += 1

    def put_negative_perm(self, path):
        """snapshot 启动预填的 ENOENT，永久有效。"""
        with self._lock:
            self._negative_perm.put(path)

    def invalidate_negative(self, path):
        """文件被创建时调用，让之前的负缓存立即失效。"""
        with self._lock:
            self._negative_perm.invalidate_prefix(path)

    def get_stat(self, path):
        with self._lock:
            # 永久层（snapshot 预填）优先，无 TTL
            perm = self._stat_perm.get(path)
            if perm is not None:
                self.stat_hit += 1
                return perm
            entry = self._stat.get(path)
            if entry is None:
                self.stat_miss_absent += 1
                self._record_miss_sample("stat", "absent", path)
                return None
            if (time.monotonic() - entry[0]) >= self._stat_ttl:
                self.stat_miss_expired += 1
                self._record_miss_sample("stat", "expired", path)
                return None
            self.stat_hit += 1
            return entry[1]

    def put_stat(self, path, st):
        with self._lock:
            self._stat[path] = (time.monotonic(), st)

    def get_readdir(self, path):
        with self._lock:
            perm = self._readdir_perm.get(path)
            if perm is not None:
                self.readdir_hit += 1
                return perm
            entry = self._readdir.get(path)
            if entry is None:
                self.readdir_miss_absent += 1
                self._record_miss_sample("readdir", "absent", path)
                return None
            if (time.monotonic() - entry[0]) >= self._readdir_ttl:
                self.readdir_miss_expired += 1
                self._record_miss_sample("readdir", "expired", path)
                return None
            self.readdir_hit += 1
            return entry[1]

    def put_readdir(self, path, entries):
        with self._lock:
            self._readdir[path] = (time.monotonic(), entries)

    def get_read(self, path, offset, size):
        with self._lock:
            perm = self._read_perm.get(path)
            if perm is not None:
                self.read_hit += 1
                return perm[offset:offset + size]
            entry = self._read.get(path)
            if entry is None:
                self.read_miss_absent += 1
                self._record_miss_sample("read", "absent", path)
                return None
            if (time.monotonic() - entry[0]) >= self._read_ttl:
                self.read_miss_expired += 1
                self._record_miss_sample("read", "expired", path)
                return None
            self.read_hit += 1
            data = entry[1]
            return data[offset:offset + size]

    def put_read_full(self, path, data):
        if len(data) > self._read_max_size:
            return
        with self._lock:
            self._read[path] = (time.monotonic(), data)

    # snapshot 启动预填用：永久层，无 TTL
    def put_stat_perm(self, path, st):
        with self._lock:
            self._stat_perm[path] = st

    def put_readdir_perm(self, path, entries):
        with self._lock:
            self._readdir_perm[path] = entries

    def put_read_perm(self, path, data):
        if len(data) > self._read_max_size:
            return
        with self._lock:
            self._read_perm[path] = data

    def invalidate(self, path):
        with self._lock:
            self._stat.pop(path, None)
            self._read.pop(path, None)
            parent = os.path.dirname(path)
            self._readdir.pop(parent, None)
            self._readdir.pop(path, None)
            # 写/创建发生时，snapshot 预填的永久层也必须失效——否则 CC 写入后
            # getattr 还会拿到旧 stat，readdir 还看不到新文件，read 拿到旧内容。
            self._stat_perm.pop(path, None)
            self._read_perm.pop(path, None)
            self._readdir_perm.pop(parent, None)
            self._readdir_perm.pop(path, None)
            # "不存在" 缓存同样要清——否则文件已经创建但 getattr 仍返 ENOENT。
            self._negative_perm.invalidate_prefix(path)

    def clear(self):
        with self._lock:
            self._stat.clear()
            self._readdir.clear()
            self._read.clear()
            self._stat_perm.clear()
            self._readdir_perm.clear()
            self._read_perm.clear()
            self._negative_perm.clear()

_cache = Cache()

# ============================================================
# JSON-RPC 通信
# ============================================================

def next_req_id():
    global _req_counter
    with _req_lock:
        _req_counter += 1
        return f"fuse-{_req_counter}"

def send_request(req):
    """发送 JSON 请求到 stdout，等待 stdin 响应。"""
    req_id = req["reqId"]
    event = threading.Event()
    result_holder = {"result": None}

    with _pending_lock:
        _pending[req_id] = (event, result_holder)

    with _stdout_lock:
        sys.stdout.write(json.dumps(req) + "\n")
        sys.stdout.flush()

    # 等待响应，超时 30 秒
    if not event.wait(timeout=30.0):
        with _pending_lock:
            _pending.pop(req_id, None)
        raise FuseOSError(errno.EIO)

    resp = result_holder["result"]
    if resp is None:
        raise FuseOSError(errno.EIO)

    if "error" in resp and resp["error"]:
        code = resp["error"].get("code", errno.EIO)
        raise FuseOSError(code)

    return resp

def response_reader():
    """从 stdin 读取 JSON 响应，dispatch 到等待的请求。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = json.loads(line)
        except Exception:
            continue

        req_id = resp.get("reqId")
        if not req_id:
            continue

        with _pending_lock:
            entry = _pending.pop(req_id, None)

        if entry:
            event, result_holder = entry
            result_holder["result"] = resp
            event.set()

# ============================================================
# 路径解析
# ============================================================

def parse_fuse_path(fuse_path):
    """
    将 FUSE 内路径解析为 (root_name, rel_path)。
    /home-claude/settings.json → ("home-claude", "settings.json")
    /home-claude-json → ("home-claude-json", "")
    / → (None, "")
    """
    parts = fuse_path.strip("/").split("/", 1)
    if not parts or not parts[0]:
        return None, ""
    root_name = parts[0]
    rel_path = parts[1] if len(parts) > 1 else ""
    return root_name, rel_path

def resolve_hand_path(root_name, rel_path):
    """将虚拟根名 + 相对路径解析为 Hand 侧绝对路径。"""
    hand_root = ROOTS.get(root_name)
    if not hand_root:
        return None
    if rel_path:
        return os.path.join(hand_root, rel_path)
    return hand_root

def is_ancestor_root(root_name):
    return root_name.startswith("cwd-ancestor-")

def resolve_shadow_path(fuse_path):
    """返回 shadow file 对应的本地真实路径；非 shadow file 返回 None。"""
    return SHADOW_FILES.get(fuse_path.lstrip("/"))

def shadow_child_names(fuse_path):
    """返回 shadow file 在 fuse_path 目录下贡献的直接子节点名。"""
    normalized = fuse_path.strip("/")
    prefix = f"{normalized}/" if normalized else ""
    names = []
    for shadow_key in SHADOW_FILES:
        if not shadow_key.startswith(prefix):
            continue
        remainder = shadow_key[len(prefix):]
        if not remainder:
            continue
        child = remainder.split("/", 1)[0]
        if child and child not in names:
            names.append(child)
    return names

def has_shadow_descendant(fuse_path):
    """fuse_path 是否是某个 shadow file 的父目录。"""
    return len(shadow_child_names(fuse_path)) > 0

# ============================================================
# 虚拟节点 stat
# ============================================================

def virtual_dir_stat():
    now = int(time.time())
    return {
        "st_mode": stat_mod.S_IFDIR | 0o755,
        "st_nlink": 2,
        "st_size": 0,
        "st_atime": now,
        "st_mtime": now,
        "st_ctime": now,
        "st_uid": os.getuid(),
        "st_gid": os.getgid(),
    }

def virtual_file_stat():
    now = int(time.time())
    return {
        "st_mode": stat_mod.S_IFREG | 0o644,
        "st_nlink": 1,
        "st_size": 0,
        "st_atime": now,
        "st_mtime": now,
        "st_ctime": now,
        "st_uid": os.getuid(),
        "st_gid": os.getgid(),
    }

def stat_from_resp(st):
    mode = st["mode"]
    if st.get("isDir"):
        mode = stat_mod.S_IFDIR | (mode & 0o7777)
    else:
        mode = stat_mod.S_IFREG | (mode & 0o7777)
    return {
        "st_mode": mode,
        "st_nlink": 2 if st.get("isDir") else 1,
        "st_size": st.get("size", 0),
        "st_atime": st.get("atime", 0),
        "st_mtime": st.get("mtime", 0),
        "st_ctime": st.get("mtime", 0),
        "st_uid": st.get("uid", os.getuid()),
        "st_gid": st.get("gid", os.getgid()),
    }

# ============================================================
# FUSE Operations
# ============================================================

class CerelayFuseOps(Operations):

    def getattr(self, path, fh=None):
        # 虚拟根目录
        if path == "/":
            return virtual_dir_stat()

        root_name, rel_path = parse_fuse_path(path)
        if root_name is None:
            raise FuseOSError(errno.ENOENT)

        # 虚拟根条目本身
        if not rel_path and root_name in ROOTS:
            if root_name == "home-claude-json":
                # 单文件根：代理到 Hand 获取真实 size，否则 read 时内核不会请求数据
                hand_path = ROOTS[root_name]
                cached = _cache.get_stat(hand_path)
                if cached:
                    return cached
                try:
                    resp = send_request({
                        "reqId": next_req_id(),
                        "op": "getattr",
                        "root": root_name,
                        "relPath": "",
                    })
                    result = stat_from_resp(resp["stat"])
                    _cache.put_stat(hand_path, result)
                    return result
                except FuseOSError:
                    # Hand 不可达或文件不存在时返回空文件
                    return virtual_file_stat()
            else:
                # 目录根：始终本地返回，不联系 Hand
                return virtual_dir_stat()

        if root_name not in ROOTS:
            raise FuseOSError(errno.ENOENT)

        if root_name.startswith("cwd-ancestor-") and rel_path:
            if rel_path not in ANCESTOR_ROOT_ALLOWED_FILES:
                raise FuseOSError(errno.ENOENT)

        # Shadow file: 本地文件优先（如 hook injection 的 settings.local.json）
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                st = os.stat(local_path)
                return {
                    "st_mode": st.st_mode,
                    "st_nlink": st.st_nlink,
                    "st_size": st.st_size,
                    "st_atime": int(st.st_atime),
                    "st_mtime": int(st.st_mtime),
                    "st_ctime": int(st.st_ctime),
                    "st_uid": st.st_uid,
                    "st_gid": st.st_gid,
                }
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        if has_shadow_descendant(path):
            return virtual_dir_stat()

        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.ENOENT)

        # 负缓存命中：snapshot 预填（broken symlink）或运行时学到（CC 反复探测的
        # 不存在文件）。直接抛 ENOENT，不发 RPC 给 server。
        if _cache.is_negative(hand_path):
            raise FuseOSError(errno.ENOENT)

        cached = _cache.get_stat(hand_path)
        if cached:
            return cached

        try:
            resp = send_request({
                "reqId": next_req_id(),
                "op": "getattr",
                "root": root_name,
                "relPath": rel_path,
            })
        except FuseOSError as e:
            # ENOENT 落入负缓存；其他错误（EIO 等）不缓存，避免短期错误污染。
            if e.errno == errno.ENOENT:
                _cache.put_negative(hand_path)
            raise
        result = stat_from_resp(resp["stat"])
        _cache.put_stat(hand_path, result)
        return result

    def readdir(self, path, fh):
        if path == "/":
            return [".", ".."] + list(ROOTS.keys())

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.ENOENT)

        # home-claude-json 是文件，不能 readdir
        if root_name == "home-claude-json":
            raise FuseOSError(errno.ENOTDIR)

        if root_name.startswith("cwd-ancestor-"):
            if rel_path:
                raise FuseOSError(errno.ENOTDIR)
            return [".", ".."] + list(ANCESTOR_ROOT_ALLOWED_FILES)

        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.ENOENT)

        if _cache.is_negative(hand_path):
            raise FuseOSError(errno.ENOENT)

        cached = _cache.get_readdir(hand_path)
        if cached is not None:
            entries = list(cached)
            for shadow_name in shadow_child_names(path):
                if shadow_name not in entries:
                    entries.append(shadow_name)
            return [".", ".."] + entries

        try:
            resp = send_request({
                "reqId": next_req_id(),
                "op": "readdir",
                "root": root_name,
                "relPath": rel_path,
            })
            entries = resp.get("entries", [])
        except FuseOSError as e:
            if e.errno == errno.ENOENT:
                _cache.put_negative(hand_path)
            raise

        # 注入 shadow file 到目录列表（如 hook injection 的 settings.local.json）。
        # 如果 shadow file 的父目录不存在，也要虚拟出中间目录（例如 .claude）。
        for shadow_name in shadow_child_names(path):
            if shadow_name not in entries:
                entries.append(shadow_name)

        _cache.put_readdir(hand_path, entries)
        return [".", ".."] + entries

    def read(self, path, size, offset, fh):
        # Shadow file: 本地读取
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                with open(local_path, "rb") as f:
                    f.seek(offset)
                    return f.read(size)
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.ENOENT)

        hand_path = resolve_hand_path(root_name, rel_path)
        if hand_path:
            if _cache.is_negative(hand_path):
                raise FuseOSError(errno.ENOENT)
            cached = _cache.get_read(hand_path, offset, size)
            if cached is not None:
                return cached

        try:
            resp = send_request({
                "reqId": next_req_id(),
                "op": "read",
                "root": root_name,
                "relPath": rel_path,
                "offset": offset,
                "size": size,
            })
        except FuseOSError as e:
            if e.errno == errno.ENOENT and hand_path:
                _cache.put_negative(hand_path)
            raise
        data = resp.get("data", "")
        decoded = base64.b64decode(data)

        # 首次从 offset 0 读取时缓存完整内容（小文件）
        if hand_path and offset == 0:
            _cache.put_read_full(hand_path, decoded)

        return decoded

    # ================================================================
    # 写操作代理到 Hand
    # Claude Code 启动时需要写入内部文件（sessions、backups、.config.json 等）。
    # Tool Use 触发的文件修改通过 PreToolUse Hook 在 Hand 侧执行，不走 FUSE。
    # ================================================================

    def write(self, path, data, offset, fh):
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                fd = os.open(local_path, os.O_WRONLY)
                try:
                    os.lseek(fd, offset, os.SEEK_SET)
                    written = os.write(fd, bytes(data))
                finally:
                    os.close(fd)
                _cache.invalidate(local_path)
                return written
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        resp = send_request({
            "reqId": next_req_id(),
            "op": "write",
            "root": root_name,
            "relPath": rel_path,
            "data": base64.b64encode(bytes(data)).decode("ascii"),
            "offset": offset,
        })
        _cache.invalidate(hand_path)
        return resp.get("written", len(data))

    def create(self, path, mode, fi=None):
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                fd = os.open(local_path, os.O_WRONLY | os.O_CREAT, mode)
                os.close(fd)
                _cache.invalidate(local_path)
                return 0
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "create",
            "root": root_name,
            "relPath": rel_path,
            "mode": mode,
        })
        _cache.invalidate(hand_path)
        return 0

    def unlink(self, path):
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                os.unlink(local_path)
                _cache.invalidate(local_path)
                return
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "unlink",
            "root": root_name,
            "relPath": rel_path,
        })
        _cache.invalidate(hand_path)

    def mkdir(self, path, mode):
        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "mkdir",
            "root": root_name,
            "relPath": rel_path,
            "mode": mode,
        })
        _cache.invalidate(hand_path)

    def rmdir(self, path):
        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "rmdir",
            "root": root_name,
            "relPath": rel_path,
        })
        _cache.invalidate(hand_path)

    def rename(self, old, new):
        old_shadow = resolve_shadow_path(old)
        new_shadow = resolve_shadow_path(new)
        if old_shadow or new_shadow:
            if not old_shadow or not new_shadow:
                raise FuseOSError(errno.EXDEV)
            try:
                os.replace(old_shadow, new_shadow)
                _cache.invalidate(old_shadow)
                _cache.invalidate(new_shadow)
                return
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        old_root, old_rel = parse_fuse_path(old)
        new_root, new_rel = parse_fuse_path(new)
        if old_root not in ROOTS or new_root not in ROOTS:
            raise FuseOSError(errno.EROFS)
        old_hand = resolve_hand_path(old_root, old_rel)
        new_hand = resolve_hand_path(new_root, new_rel)
        if not old_hand or not new_hand:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "rename",
            "root": old_root,
            "relPath": old_rel,
            "newRoot": new_root,
            "newRelPath": new_rel,
        })
        _cache.invalidate(old_hand)
        _cache.invalidate(new_hand)

    def truncate(self, path, length, fh=None):
        local_path = resolve_shadow_path(path)
        if local_path:
            try:
                with open(local_path, "r+b") as f:
                    f.truncate(length)
                _cache.invalidate(local_path)
                return
            except OSError as e:
                raise FuseOSError(e.errno or errno.EIO)

        root_name, rel_path = parse_fuse_path(path)
        if root_name not in ROOTS:
            raise FuseOSError(errno.EROFS)
        hand_path = resolve_hand_path(root_name, rel_path)
        if not hand_path:
            raise FuseOSError(errno.EROFS)
        send_request({
            "reqId": next_req_id(),
            "op": "truncate",
            "root": root_name,
            "relPath": rel_path,
            "size": length,
        })
        _cache.invalidate(hand_path)

    def utimens(self, path, times=None):
        # utimens 不算实质性修改，静默忽略即可
        return

    def chmod(self, path, mode):
        # Claude Code 不需要 chmod，静默忽略
        return

    def chown(self, path, uid, gid):
        # Claude Code 不需要 chown，静默忽略
        return

    def open(self, path, flags):
        # 无状态，返回 0 作为 fh
        return 0

    def flush(self, path, fh):
        return

    def release(self, path, fh):
        return

    def fsync(self, path, datasync, fh):
        return

    def init(self, path):
        # FUSE mount 成功后回调，写就绪标记
        if READY_FILE:
            try:
                with open(READY_FILE, "w") as f:
                    f.write("ready")
            except Exception:
                pass

# ============================================================
# 控制管道处理
# ============================================================

fuse_instance = None

def handle_control():
    """Control pipe handler: line-delimited JSON, fire-and-forget (no response).

    Server (DaemonControlClient) writes to fd, daemon reads + applies.
    协议设计见 spec §7.3.4。
    """
    global fuse_instance
    try:
        with os.fdopen(CONTROL_FD, "r", encoding="utf-8", buffering=1) as control:
            for line in control:
                if not line:
                    break
                try:
                    message = json.loads(line)
                except Exception:
                    continue
                msg_type = message.get("type")
                if msg_type == "shutdown":
                    # 请求 FUSE 退出
                    if fuse_instance:
                        try:
                            import subprocess
                            subprocess.run(
                                ["fusermount", "-u", MOUNT_POINT],
                                timeout=5,
                                capture_output=True,
                            )
                        except Exception:
                            pass
                    break
                elif msg_type == "put_negative":
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _cache.put_negative_perm(path)
                elif msg_type == "invalidate_negative_prefix":
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _cache.invalidate_negative(path)
                elif msg_type == "invalidate_cache":
                    # 精确清理某 path 的 stat/readdir/read 缓存 (非 clear-all)
                    path = message.get("path")
                    if isinstance(path, str) and path:
                        _cache.invalidate(path)
                # 未知 type: 静默忽略 (forward-compat)
    except OSError:
        pass

# ============================================================
# 主入口
# ============================================================

# 启动响应读取线程
reader_thread = threading.Thread(target=response_reader, daemon=True)
reader_thread.start()

# 启动控制管道处理线程
control_thread = threading.Thread(target=handle_control, daemon=True)
control_thread.start()

# 从快照文件加载缓存（由 Brain 在启动 FUSE 前通过 Hand snapshot 请求收集）
_snapshot_file = os.environ.get("CERELAY_FUSE_CACHE_SNAPSHOT", "")
if _snapshot_file and os.path.isfile(_snapshot_file):
    try:
        with open(_snapshot_file, "r") as f:
            _snapshot = json.load(f)
        _stat_keys = list(_snapshot.get("stats", {}).keys())
        _readdir_keys = list(_snapshot.get("readdirs", {}).keys())
        _read_keys = list(_snapshot.get("reads", {}).keys())
        _negative_keys = list(_snapshot.get("negatives", []))
        _loaded = 0
        # 全部走 perm 层：snapshot 反映启动那一刻 client 的真实状态，应当
        # 永久有效；TTL 失效会让真实存在的文件在启动几十秒后还是穿透 client。
        # 写/创建时 invalidate(path) 会把 perm 层连带清掉，一致性安全。
        for path_key, stat_val in _snapshot.get("stats", {}).items():
            _cache.put_stat_perm(path_key, stat_val)
            _loaded += 1
        for path_key, entries_val in _snapshot.get("readdirs", {}).items():
            _cache.put_readdir_perm(path_key, entries_val)
            _loaded += 1
        for path_key, data_val in _snapshot.get("reads", {}).items():
            _cache.put_read_perm(path_key, base64.b64decode(data_val))
            _loaded += 1
        for neg_path in _negative_keys:
            _cache.put_negative_perm(neg_path)
            _loaded += 1
        # 诊断：snapshot 载入完毕的总条数 + 各类型 key 数 + 头/尾抽样 path。
        # 用 [FUSE-DIAG] 前缀以便 server 端把这一行提到 INFO。
        def _sample(keys, n=3):
            if not keys:
                return []
            head = keys[:n]
            tail = keys[-n:] if len(keys) > n else []
            return head + (["..."] + tail if tail and head[-1] != tail[0] else [])
        # build_marker 同 server/src/index.ts 的 buildFeatureMarker，让用户看
        # FUSE 端口日志也能立刻判断 Python 脚本是新还是旧（Docker image 重建后才更新）。
        sys.stderr.write(
            f"[FUSE-DIAG] snapshot loaded: build_marker=snapshot-negatives+fuse-neg-cache+depth8 "
            f"total={_loaded} "
            f"stats={len(_stat_keys)} readdirs={len(_readdir_keys)} reads={len(_read_keys)} "
            f"negatives={len(_negative_keys)} "
            f"stat_sample={_sample(_stat_keys)} "
            f"readdir_sample={_sample(_readdir_keys)} "
            f"read_sample={_sample(_read_keys)} "
            f"negative_sample={_sample(_negative_keys)}\n"
        )
    except Exception as e:
        sys.stderr.write(f"[FUSE-DIAG] snapshot load failed (cold start): {e}\n")
else:
    sys.stderr.write(
        f"[FUSE-DIAG] snapshot file unavailable (cold start): "
        f"file={_snapshot_file or '<unset>'} exists={os.path.isfile(_snapshot_file) if _snapshot_file else False}\n"
    )

# 启动期周期诊断线程：每 5s 输出一次 cache hit/miss 计数 + 抽样未命中 path。
# 60s 后停。
def _cache_stats_reporter():
    started_at = time.monotonic()
    last_drained = 0
    while True:
        time.sleep(5.0)
        elapsed = time.monotonic() - started_at
        if elapsed > 60.0:
            return
        with _cache._lock:
            stat_h, stat_a, stat_e = _cache.stat_hit, _cache.stat_miss_absent, _cache.stat_miss_expired
            rd_h, rd_a, rd_e = _cache.readdir_hit, _cache.readdir_miss_absent, _cache.readdir_miss_expired
            rd_r_h, rd_r_a, rd_r_e = _cache.read_hit, _cache.read_miss_absent, _cache.read_miss_expired
            neg_perm = _cache.negative_hit_perm
            neg_runtime = _cache.negative_hit_runtime
            neg_recorded = _cache.negative_recorded
            samples = list(_cache.miss_samples[last_drained:last_drained + 20])
            last_drained = len(_cache.miss_samples)
        sys.stderr.write(
            f"[FUSE-DIAG] cache stats elapsed={elapsed:.1f}s "
            f"stat(hit={stat_h} absent={stat_a} expired={stat_e}) "
            f"readdir(hit={rd_h} absent={rd_a} expired={rd_e}) "
            f"read(hit={rd_r_h} absent={rd_r_a} expired={rd_r_e}) "
            f"negative(hit_perm={neg_perm} hit_runtime={neg_runtime} recorded={neg_recorded}) "
            f"recent_miss_samples={samples}\n"
        )

_diag_thread = threading.Thread(target=_cache_stats_reporter, daemon=True)
_diag_thread.start()

# 确保挂载点存在
os.makedirs(MOUNT_POINT, exist_ok=True)

try:
    # Tuning rationale (Plan: 启动期 FUSE 穿透优化):
    #   nothreads=False         libfuse 多线程派发 op；CC 并发 syscall 才能并发处理。
    #   max_background=10       libfuse 允许同时在飞的请求数（默认 12，显式锁定 10
    #                           作为 CC parallelism 的上限）。
    #   attr_timeout / entry_timeout = 10.0
    #                           内核 stat / dentry 缓存 TTL 从默认 1.0s 提到 10.0s，
    #                           启动期的重复 getattr 大量直接命中内核缓存，不再穿透。
    #                           ~/.claude 命名空间内只有 CC 在写，写后 kernel 自身
    #                           会失效相关条目，cache 一致性安全。
    fuse_instance = FUSE(
        CerelayFuseOps(),
        MOUNT_POINT,
        foreground=True,
        nothreads=False,
        allow_other=False,
        max_background=10,
        attr_timeout=10.0,
        entry_timeout=10.0,
    )
except Exception as e:
    sys.stderr.write(f"FUSE mount failed: {e}\n")
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
`;
