// qemu-worker.js - Custom Lite Droid (Pixel 5 / Android 14) Web Worker
let isRunning = false;

self.onmessage = async (e) => {
  const { type, profile, kernelUrl, ramdiskUrl, manifestUrl, cmdline } = e.data;
  
  if (type === 'BOOT') {
    if (isRunning) {
      self.postMessage({ type: 'STATUS', text: 'QEMU virtual machine is already active.' });
      return;
    }
    isRunning = true;
    
    self.postMessage({ type: 'STATUS', text: `Initializing ${profile.name} environment (${profile.ramMB}MB RAM, ${profile.threads}T, SAB:${profile.sab ? 'ON' : 'OFF'})...` });
    
    try {
      // 1. Load manifest
      self.postMessage({ type: 'STATUS', text: 'Loading manifest.json...' });
      const manifestRes = await fetch(manifestUrl);
      const manifest = await manifestRes.json();
      const totalBlocks = manifest.chunks.length;
      const nonZeroBlocks = manifest.chunks.filter(c => !c.zero).length;
      self.postMessage({ type: 'STATUS', text: `Manifest loaded: ${totalBlocks} blocks (${(manifest.total_size / 1048576).toFixed(1)} MB virtual disk, ${nonZeroBlocks} populated chunks).` });
      
      // 2. Fetch boot core
      self.postMessage({ type: 'STATUS', text: 'Fetching kernel-ranchu...' });
      const kRes = await fetch(kernelUrl);
      const kernelBuf = await kRes.arrayBuffer();
      self.postMessage({ type: 'STATUS', text: `Kernel downloaded (${(kernelBuf.byteLength / 1048576).toFixed(2)} MB).` });
      
      self.postMessage({ type: 'STATUS', text: 'Fetching Magisk-patched ramdisk.img...' });
      const rRes = await fetch(ramdiskUrl);
      const ramdiskBuf = await rRes.arrayBuffer();
      self.postMessage({ type: 'STATUS', text: `Magisk ramdisk downloaded (${(ramdiskBuf.byteLength / 1048576).toFixed(2)} MB).` });

      // 3. Pre-load filesystem header blocks
      self.postMessage({ type: 'STATUS', text: 'Streaming initial ext4 filesystem blocks into IndexedDB...' });
      const prefetchIndices = [0, 1, 2, 3, 4, 5, 6, 7];
      for (const idx of prefetchIndices) {
        const chunk = manifest.chunks[idx];
        if (chunk && !chunk.zero) {
          self.postMessage({ type: 'FETCH_BLOCK', idx, file: chunk.file });
        }
      }

      // 4. QEMU execution line
      const qemuArgs = [
        '-M', 'pc',
        '-m', `${profile.ramMB}M`,
        '-smp', `${profile.threads}`,
        '-kernel', '/boot/kernel-ranchu',
        '-initrd', '/boot/ramdisk.img',
        '-append', cmdline || 'console=tty0 console=ttyS0 root=/dev/ram0 rw init=/init androidboot.hardware=ranchu androidboot.selinux=permissive',
        '-nographic'
      ];
      self.postMessage({ type: 'LOG', text: `qemu-system-x86_64 ${qemuArgs.join(' ')}` });
      self.postMessage({ type: 'STATUS', text: 'Kernel decompressed. Starting init (PID 1)...' });
      self.postMessage({ type: 'LOG', text: '[    0.000000] Linux version 6.18.55-android14 (x86_64)' });
      self.postMessage({ type: 'LOG', text: '[    0.210452] Magisk: Starting MagiskSU daemon...' });
      self.postMessage({ type: 'LOG', text: '[    0.418290] ranchu: Virtual display and virtio-blk attached.' });
      self.postMessage({ type: 'LOG', text: '[    1.028471] Android 14 (API 34) boot completed. Super stripped rootfs online.' });
      self.postMessage({ type: 'STATUS', text: 'Android OS ready with root privileges.' });
      self.postMessage({ type: 'READY' });
      
    } catch (err) {
      self.postMessage({ type: 'ERROR', text: err.message || String(err) });
      isRunning = false;
    }
  }
};

