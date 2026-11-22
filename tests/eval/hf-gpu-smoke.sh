#!/usr/bin/env bash
# One Hugging Face Job on a GPU (t4-small): does Chrome's WebGPU get the GPU in a headless Linux container, and how fast
# is LFM3 1.7B on Tilde there? HF reserves NVIDIA_DRIVER_CAPABILITIES, so when the driver's Vulkan libraries aren't
# mounted the script installs the same driver version's user-space libraries itself (Chrome's WebGPU needs Vulkan).
#   1. nvidia-smi and vulkaninfo: is there a GPU, and does Vulkan see it?
#   2. tests/eval/gpu-probe.mjs: which Chrome switches give WebGPU a hardware adapter, and a timed matmul.
#   3. If one does: deliberation case 1 ("Tell me about Olivia Rodrigo") through the real app on Tilde, timed.
set -u
BRANCH="${SQUIGGLE_BRANCH:-gpu-smoke}"
step() { echo; echo "=== $* ($(date -u +%T))"; }

step "GPU"
nvidia-smi || echo "no nvidia-smi"

step "packages"
apt-get update -qq >/dev/null && apt-get install -y -qq git curl ca-certificates libvulkan1 vulkan-tools >/dev/null 2>&1 && echo installed
echo "NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES:-unset} (HF reserves it: a job can't set it)"

# Without "graphics" in those capabilities the toolkit mounts CUDA but not the driver's Vulkan libraries. They're
# user-space only, so the same version's installer can supply them: extract it and copy in what isn't there.
VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')
LIB=/usr/lib/x86_64-linux-gnu
# The test is whether Vulkan sees the GPU, not whether a library file exists: HF's T4 (driver 620.70.06, capabilities
# compute,utility) has a libGLX_nvidia that loads but can't create a Vulkan instance (webgpu-smoke-3).
if [ -n "$VER" ] && ! vulkaninfo --summary 2>/dev/null | grep -qi "deviceName.*\(nvidia\|tesla\)"; then
  echo "no Vulkan driver mounted: fetching NVIDIA $VER user-space libraries"
  for url in "https://us.download.nvidia.com/tesla/$VER/NVIDIA-Linux-x86_64-$VER.run" \
             "https://us.download.nvidia.com/XFree86/Linux-x86_64/$VER/NVIDIA-Linux-x86_64-$VER.run"; do
    curl -fsSLo /tmp/nv.run "$url" && break
  done
  if [ -s /tmp/nv.run ] && sh /tmp/nv.run -x --target /opt/nv >/dev/null 2>&1; then
    # Every library of this version, over whatever partial copy is there (same version, so CUDA's own are unchanged).
    cp -f /opt/nv/*.so."$VER" "$LIB/"
    ldconfig
    mkdir -p /usr/share/vulkan/icd.d
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json
    echo "copied in: $(ls /opt/nv/*.so."$VER" | wc -l) libraries"
  else
    echo "could not get the NVIDIA $VER installer"
  fi
fi
# The toolkit mounts the driver's libraries but not always the loader's ICD file: write it if it's missing.
if ! ls /usr/share/vulkan/icd.d/nvidia_icd.json /etc/vulkan/icd.d/nvidia_icd.json >/dev/null 2>&1; then
  mkdir -p /usr/share/vulkan/icd.d
  echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json
  echo "wrote nvidia_icd.json"
fi
ls -la /usr/lib/x86_64-linux-gnu/ | grep -i -E "nvidia|libGLX" | head -20

step "vulkaninfo"
vulkaninfo --summary 2>&1 | grep -v XDG_RUNTIME_DIR | head -60

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
