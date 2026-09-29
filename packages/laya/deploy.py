"""Copy the Laya server and trainer scripts to the machines that run them.

    python deploy.py                 this PC:   %LOCALAPPDATA%/Augur/laya/lora and run-laya.ps1
    python deploy.py --bilbo         the Mac mini: ~/laya-serve/lora over ssh

Both hosts run the same files from a `lora` folder inside their Laya home, so the scripts find the
adapters, data and logs one level up without any setting.
"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
FILES = ["env.py", "lora.py", "ctxutil.py", "loadgate.py", "pool.py", "sync.py", "selftrain.py", "serve_lora.py", "train.py"]
BILBO = os.environ.get("LAYA_BILBO", "strider@192.168.2.154")


def local_home() -> str:
    return os.environ.get("LAYA_HOME") or os.path.join(os.environ["LOCALAPPDATA"], "Augur", "laya")


def main() -> None:
    if "--bilbo" in sys.argv:
        for f in FILES:
            subprocess.run(["scp", "-q", os.path.join(SRC, f), f"{BILBO}:laya-serve/lora/{f}"], check=True)
        print(f"copied {len(FILES)} files to {BILBO}:laya-serve/lora")
        return
    dest = os.path.join(local_home(), "lora")
    os.makedirs(dest, exist_ok=True)
    for f in FILES:
        shutil.copyfile(os.path.join(SRC, f), os.path.join(dest, f))
    shutil.copyfile(os.path.join(HERE, "windows", "run-laya.ps1"), os.path.join(local_home(), "run-laya.ps1"))
    print(f"copied {len(FILES)} files to {dest}, and the launcher beside it")


if __name__ == "__main__":
    main()
