"""The GPU smoke test (tests/eval/hf-gpu-smoke.sh) on a Modal T4: does Chrome's WebGPU get the GPU, and how fast is
LFM3 1.7B on Tilde there? (Chrome's headless shell with Vulkan gets the T4 here: 2026-11-22, matmul 10.6 ms.) Run by .github/workflows/modal-smoke.yml with the MODAL_TOKEN_ID / MODAL_TOKEN_SECRET secrets.

    modal run tests/eval/modal_smoke.py --branch gpu-smoke

The script's output streams to the caller's terminal; the probe and case results come back and are written to out/.
"""
import os
import subprocess

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl", "ca-certificates", "xz-utils", "libvulkan1", "vulkan-tools")
    .run_commands(
        "curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar -xJ -C /opt",
        "ln -s /opt/node-v22.11.0-linux-x64/bin/node /opt/node-v22.11.0-linux-x64/bin/npm "
        "/opt/node-v22.11.0-linux-x64/bin/npx /usr/local/bin/",
    )
)
app = modal.App("squiggle-gpu-smoke")


@app.function(image=image, gpu="T4", timeout=45 * 60)
def smoke(branch: str) -> dict:
    print("NVIDIA_DRIVER_CAPABILITIES=" + os.environ.get("NVIDIA_DRIVER_CAPABILITIES", "unset"), flush=True)
    url = f"https://raw.githubusercontent.com/KealJones/squiggle/{branch}/tests/eval/hf-gpu-smoke.sh"
    code = subprocess.run(["bash", "-c", f"curl -fsSL {url} -o /tmp/smoke.sh && bash /tmp/smoke.sh"],
                          env={**os.environ, "SQUIGGLE_BRANCH": branch}).returncode
    out = {"exit_code": code}
    for f in ("/tmp/probe.txt", "/tmp/case1.json"):
        if os.path.exists(f):
            out[os.path.basename(f)] = open(f).read()
    return out


@app.local_entrypoint()
def main(branch: str = "gpu-smoke"):
    r = smoke.remote(branch)
    os.makedirs("out", exist_ok=True)
    for name, text in r.items():
        if name != "exit_code":
            open(os.path.join("out", name), "w").write(text)
    print(f"\nexit code {r['exit_code']}; wrote: {', '.join(k for k in r if k != 'exit_code') or 'nothing'}")
