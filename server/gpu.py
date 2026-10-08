"""One queue for everything that runs on the GPU, most urgent first.

PyTorch's MPS backend isn't safe across threads: two models running at once corrupted Whisper's
output (invalid token ids) and slowed both ~50x. So work takes turns, and a rider's speech is
recognized before any queued speech clip is made. A clip already running can't be interrupted.
"""
import threading
from contextlib import contextmanager

SPEECH_IN = 0  # rider just spoke: answer in ~1 s
LIVE_TTS = 1  # rider is waiting for this clip
BACKGROUND = 2  # pre-making clips nobody is waiting for yet

_cond = threading.Condition()
_busy = False
_waiting = [0, 0, 0]


@contextmanager
def use(priority):
    global _busy
    with _cond:
        _waiting[priority] += 1
        while _busy or any(_waiting[:priority]):
            _cond.wait()
        _waiting[priority] -= 1
        _busy = True
    try:
        yield
    finally:
        with _cond:
            _busy = False
            _cond.notify_all()
