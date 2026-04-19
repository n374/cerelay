export const PYTHON_PTY_HOST_SCRIPT = String.raw`
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import threading

COMMAND = sys.argv[1:]
CONTROL_FD = int(os.environ.get("CERELAY_PTY_CONTROL_FD", "3"))
COLS = int(os.environ.get("CERELAY_PTY_COLS", "80"))
ROWS = int(os.environ.get("CERELAY_PTY_ROWS", "24"))

master_fd, slave_fd = pty.openpty()

def set_winsize(cols: int, rows: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, packed)

set_winsize(COLS, ROWS)

proc = subprocess.Popen(
    COMMAND,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    preexec_fn=os.setsid,
    close_fds=True,
)
os.close(slave_fd)

running = True

def forward_input() -> None:
    global running
    try:
        while running:
            data = os.read(0, 4096)
            if not data:
                break
            os.write(master_fd, data)
    except OSError:
        pass

def handle_control() -> None:
    global running
    with os.fdopen(CONTROL_FD, "r", encoding="utf-8", buffering=1) as control:
        for line in control:
            if not line:
                break
            try:
                message = json.loads(line)
            except Exception:
                continue
            msg_type = message.get("type")
            if msg_type == "resize":
                cols = int(message.get("cols", COLS))
                rows = int(message.get("rows", ROWS))
                set_winsize(cols, rows)
                try:
                    os.killpg(proc.pid, signal.SIGWINCH)
                except OSError:
                    pass
            elif msg_type == "close":
                running = False
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
                break

input_thread = threading.Thread(target=forward_input, daemon=True)
control_thread = threading.Thread(target=handle_control, daemon=True)
input_thread.start()
control_thread.start()

try:
    while True:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd in ready:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if proc.poll() is not None:
            break
finally:
    running = False
    try:
        os.close(master_fd)
    except OSError:
        pass
    input_thread.join(timeout=0.2)
    control_thread.join(timeout=0.2)

exit_code = proc.wait()
sys.exit(exit_code if exit_code is not None else 0)
`;
