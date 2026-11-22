#!/usr/bin/env bash
# One Hugging Face Job on a GPU (t4-small): does Chrome's WebGPU get the GPU in a headless Linux container, and how fast
# is LFM3 1.7B on Tilde there? Run it in the node:22-bookworm image with NVIDIA_DRIVER_CAPABILITIES=all (the container
# toolkit then mounts the driver's Vulkan library, which Chrome's WebGPU needs; the default "compute,utility" has none).
#   1. nvidia-smi and vulkaninfo: is there a GPU, and does Vulkan see it?
#   2. tests/eval/gpu-probe.mjs: which Chrome switches give WebGPU a hardware adapter, and a timed matmul.
#   3. If one does: deliberation case 1 ("Tell me about Olivia Rodrigo") through the real app on Tilde, timed.
set -u
BRANCH="${SQUIGGLE_BRANCH:-gpu-smoke}"
step() { echo; echo "=== $* ($(date -u +%T))"; }

step "GPU"
nvidia-smi || echo "no nvidia-smi"

step "packages"
apt-get update -qq >/dev/null && apt-get install -y -qq git libvulkan1 vulkan-tools >/dev/null 2>&1 && echo installed
# The toolkit mounts the driver's libraries but not always the loader's ICD file: write it if it's missing.
if ! ls /usr/share/vulkan/icd.d/nvidia_icd.json /etc/vulkan/icd.d/nvidia_icd.json >/dev/null 2>&1; then
  mkdir -p /usr/share/vulkan/icd.d
  echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json
  echo "wrote nvidia_icd.json"
fi
ls -la /usr/lib/x86_64-linux-gnu/ | grep -i -E "nvidia|libGLX" | head -20

step "vulkaninfo"
vulkaninfo --summary 2>&1 | head -40

step "squiggle@$BRANCH"
git clone -q --depth 1 -b "$BRANCH" https://github.com/KealJones/squiggle /work/squiggle && cd /work/squiggle
npm ci --silent >/dev/null 2>&1; npm i --no-save --silent playwright >/dev/null 2>&1
npx --yes playwright install --with-deps chromium >/dev/null 2>&1 && echo "chromium installed"

step "WebGPU probe"
node tests/eval/gpu-probe.mjs | tee /tmp/probe.txt
ENVLINE=$(grep '^SQUIGGLE_CHROME_ARGS=' /tmp/probe.txt || true)
if [ -z "$ENVLINE" ]; then step "no hardware WebGPU: stopping here"; exit 2; fi
eval "export $ENVLINE"

step "case 1 on Tilde (LFM3 1.7B, Compress)"
T0=$(date +%s)
node tests/eval/run.mjs --model KLF3 --mode compact --set cases-deliberation.json --cases 1 --timeout 600 --out /tmp/case1.json --verbose 2>&1 | tail -60
echo "wall for load + case: $(( $(date +%s) - T0 )) s"
step "result"
node -e 'const r=require("/tmp/case1.json"); console.log(JSON.stringify(r, (k, v) => typeof v === "string" && v.length > 1500 ? v.slice(0, 1500) + "…" : v, 1).slice(0, 12000))' 2>&1 || echo "no result file"
