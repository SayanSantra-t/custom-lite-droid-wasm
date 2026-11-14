// qemu-worker.js — Real Code-Allergy/qemu-wasm (createRKernelQemu) ES Module Worker
import createRKernelQemu from './qemu-system-x86_64.js';

let isRunning = false;
let qemuModule = null;
const stdinQueue = [];
const encoder = new TextEncoder();

const DB_NAME = 'pixel_wasm_blocks';
const chunkCache = new Map();
const dirtyChunks = new Set();

function openBlockDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('chunks')) {
        req.result.createObjectStore('chunks');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function hydrateCacheFromIDB() {
  try {
    const db = await openBlockDB();
    await new Promise((resolve) => {
      const tx = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').openCursor();
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          chunkCache.set(Number(cursor.key), new Uint8Array(cursor.value));
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    });
  } catch (_) {}
  reportCacheStats();
}

function persistChunkAsync(idx, buf) {
  openBlockDB()
    .then((db) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(buf, idx);
    })
    .catch(() => {});
}

function reportCacheStats() {
  self.postMessage({
    type: 'CACHE_STATS',
    blocks: chunkCache.size,
    bytes: chunkCache.size * 65536
  });
}

function getChunkSync(manifest, idx) {
  if (chunkCache.has(idx)) return chunkCache.get(idx);

  const entry = manifest.chunks[idx];
  const chunkSize = manifest.chunk_size || 65536;
  if (!entry || entry.zero) {
    const zeroBuf = new Uint8Array(chunkSize);
    chunkCache.set(idx, zeroBuf);
    return zeroBuf;
  }

  const chunkUrl = new URL(`./chunks/${entry.file}`, self.location.href).href;
  const xhr = new XMLHttpRequest();
  xhr.open('GET', chunkUrl, false);
  xhr.responseType = 'arraybuffer';
  xhr.send(null);

  if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
    const buf = new Uint8Array(xhr.response);
    chunkCache.set(idx, buf);
    persistChunkAsync(idx, buf);
    if (chunkCache.size % 8 === 0 || chunkCache.size <= 16) {
      reportCacheStats();
    }
    return buf;
  }

  throw new Error(`Failed to fetch block #${idx} (${entry.file}): HTTP ${xhr.status}`);
}

function enqueueStdin(text) {
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i++) {
    stdinQueue.push(bytes[i]);
  }
}

function registerLazyDiskDevice(FS, manifest) {
  const chunkSize = manifest.chunk_size || 65536;
  const totalSize = manifest.total_size;
  const devId = FS.makedev(64, 0);

  FS.registerDevice(devId, {
    open(stream) {
      stream.seekable = true;
    },
    close() {},
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position = totalSize + offset;
      if (position < 0) throw new FS.ErrnoError(28);
      stream.position = position;
      return position;
    },
    read(stream, buffer, offset, length, position) {
      if (position >= totalSize || length <= 0) return 0;
      const maxReadable = Math.min(length, totalSize - position);
      let bytesRead = 0;

      while (bytesRead < maxReadable) {
        const curPos = position + bytesRead;
        const chunkIdx = Math.floor(curPos / chunkSize);
        const inChunkOffset = curPos % chunkSize;
        const toCopy = Math.min(maxReadable - bytesRead, chunkSize - inChunkOffset);

        const chunk = getChunkSync(manifest, chunkIdx);
        buffer.set(chunk.subarray(inChunkOffset, inChunkOffset + toCopy), offset + bytesRead);
        bytesRead += toCopy;
      }
      return bytesRead;
    },
    write(stream, buffer, offset, length, position) {
      if (position >= totalSize || length <= 0) return 0;
      const maxWritable = Math.min(length, totalSize - position);
      let bytesWritten = 0;

      while (bytesWritten < maxWritable) {
        const curPos = position + bytesWritten;
        const chunkIdx = Math.floor(curPos / chunkSize);
        const inChunkOffset = curPos % chunkSize;
        const toCopy = Math.min(maxWritable - bytesWritten, chunkSize - inChunkOffset);

        let chunk = getChunkSync(manifest, chunkIdx);
        if (!dirtyChunks.has(chunkIdx)) {
          chunk = new Uint8Array(chunk);
          chunkCache.set(chunkIdx, chunk);
          dirtyChunks.add(chunkIdx);
        }
        chunk.set(buffer.subarray(offset + bytesWritten, offset + bytesWritten + toCopy), inChunkOffset);
        persistChunkAsync(chunkIdx, chunk);
        bytesWritten += toCopy;
      }
      return bytesWritten;
    }
  });

  FS.mkdev('/disk/system.img', 0o666, devId);
}

async function fetchFirmwareAssets() {
  const candidates = [
    'bios-256k.bin',
    'bios.bin',
    'vgabios-stdvga.bin',
    'vgabios-virtio.bin',
    'vgabios-qxl.bin',
    'efi-virtio.rom',
    'kvmvapic.bin',
    'linuxboot_dma.bin'
  ];
  const loaded = [];
  await Promise.all(
    candidates.map(async (name) => {
      try {
        const url = new URL(`./firmware/${name}`, self.location.href).href;
        const res = await fetch(url);
        if (res.ok) loaded.push({ name, data: new Uint8Array(await res.arrayBuffer()) });
      } catch (_) {}
    })
  );
  return loaded;
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'CMD') {
    if (!isRunning) {
      self.postMessage({ type: 'LOG_ERR', text: 'VM is not running yet. Click Boot QEMU Wasm first.' });
      return;
    }
    enqueueStdin(msg.text.endsWith('\n') ? msg.text : `${msg.text}\n`);
    return;
  }

  if (msg.type === 'KEY') {
    if (!isRunning) return;
    const keyMap = {
      BACK: 'input keyevent 4\n',
      HOME: 'input keyevent 3\n',
      APP_SWITCH: 'input keyevent 187\n'
    };
    if (keyMap[msg.key]) {
      self.postMessage({ type: 'STATUS', text: `Injecting Android keyevent: ${msg.key}` });
      enqueueStdin(keyMap[msg.key]);
    }
    return;
  }

  if (msg.type === 'SIDELOAD') {
    const safeName = String(msg.name || 'payload.apk').replace(/[^a-zA-Z0-9._-]/g, '_');
    const bytes = new Uint8Array(msg.data);
    if (qemuModule && qemuModule.FS) {
      try {
        qemuModule.FS.writeFile(`/shared/${safeName}`, bytes);
      } catch (_) {}
    }
    if (isRunning) {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const b64 = btoa(binary);
      enqueueStdin(
        `mkdir -p /data/local/tmp && base64 -d << 'EOF_PKG' > /data/local/tmp/${safeName}\n${b64}\nEOF_PKG\nls -lh /data/local/tmp/${safeName}\n`
      );
      self.postMessage({ type: 'STATUS', text: `Injecting ${safeName} (${(bytes.byteLength / 1048576).toFixed(2)} MB) into guest /data/local/tmp/${safeName}...` });
    }
    return;
  }

  if (msg.type === 'BOOT') {
    if (isRunning) {
      self.postMessage({ type: 'STATUS', text: 'QEMU Wasm VM is already active.' });
      return;
    }
    isRunning = true;

    try {
      self.postMessage({ type: 'STATUS', text: 'Hydrating IndexedDB block cache...' });
      await hydrateCacheFromIDB();

      self.postMessage({ type: 'STATUS', text: 'Fetching manifest.json, kernel-ranchu, Magisk ramdisk.img, and firmware...' });
      const [manifest, kernelBuf, ramdiskBuf, firmwareFiles] = await Promise.all([
        fetch(new URL(msg.manifestUrl, self.location.href).href).then((r) => {
          if (!r.ok) throw new Error(`manifest.json HTTP ${r.status}`);
          return r.json();
        }),
        fetch(new URL(msg.kernelUrl, self.location.href).href).then(async (r) => {
          if (!r.ok) throw new Error(`kernel-ranchu HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        }),
        fetch(new URL(msg.ramdiskUrl, self.location.href).href).then(async (r) => {
          if (!r.ok) throw new Error(`ramdisk.img HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        }),
        fetchFirmwareAssets()
      ]);

      self.postMessage({
        type: 'STATUS',
        text: `Loaded kernel (${(kernelBuf.byteLength / 1048576).toFixed(2)} MB), ramdisk (${(ramdiskBuf.byteLength / 1048576).toFixed(2)} MB), disk (${(manifest.total_size / 1048576).toFixed(1)} MB), ${firmwareFiles.length} firmware ROMs.`
      });

      self.postMessage({ type: 'STATUS', text: 'Instantiating qemu-system-x86_64.wasm...' });

      let lineBuf = '';
      let errBuf = '';
      const flushChar = (isErr, ch) => {
        if (ch === 10 || ch === 13) {
          if (isErr) {
            if (errBuf.trim()) self.postMessage({ type: 'LOG_ERR', text: errBuf });
            errBuf = '';
          } else {
            if (lineBuf.trim()) self.postMessage({ type: 'LOG', text: lineBuf });
            lineBuf = '';
          }
          return;
        }
        const s = String.fromCharCode(ch);
        if (isErr) errBuf += s;
        else lineBuf += s;
      };

      qemuModule = await createRKernelQemu({
        noInitialRun: true,
        locateFile(path) {
          return new URL(`./${path}`, self.location.href).href;
        },
        print(text) {
          self.postMessage({ type: 'LOG', text: String(text) });
        },
        printErr(text) {
          self.postMessage({ type: 'LOG_ERR', text: String(text) });
        },
        stdin() {
          return stdinQueue.length > 0 ? stdinQueue.shift() : null;
        }
      });

      const FS = qemuModule.FS;
      if (qemuModule.TTY && typeof FS.init === 'function') {
        try {
          FS.init(
            () => (stdinQueue.length > 0 ? stdinQueue.shift() : null),
            (ch) => { if (ch !== null) flushChar(false, ch); },
            (ch) => { if (ch !== null) flushChar(true, ch); }
          );
        } catch (_) {}
      }

      for (const dir of ['/boot', '/firmware', '/disk', '/shared']) {
        try { FS.mkdir(dir); } catch (_) {}
      }

      FS.writeFile('/boot/kernel-ranchu', kernelBuf);
      FS.writeFile('/boot/ramdisk.img', ramdiskBuf);
      for (const fw of firmwareFiles) {
        FS.writeFile(`/firmware/${fw.name}`, fw.data);
      }

      registerLazyDiskDevice(FS, manifest);
      reportCacheStats();

      const profile = msg.profile || { ramMB: 768, threads: 1 };
      const guestRamMB = Math.min(profile.ramMB, 1024);
      const appendCmdline =
        msg.cmdline ||
        'console=ttyS0 earlycon=uart8250,io,0x3f8,115200n8 root=/dev/ram0 rw init=/init androidboot.hardware=ranchu androidboot.selinux=permissive';

      const qemuArgs = [
        '-L', '/firmware',
        '-M', 'pc',
        '-m', `${guestRamMB}M`,
        '-smp', `${Math.max(1, profile.threads)}`,
        '-kernel', '/boot/kernel-ranchu',
        '-initrd', '/boot/ramdisk.img',
        '-drive', 'file=/disk/system.img,format=raw,if=virtio',
        '-append', appendCmdline,
        '-nographic',
        '-serial', 'mon:stdio'
      ];

      self.postMessage({ type: 'STATUS', text: `Starting QEMU TCG: qemu-system-x86_64 ${qemuArgs.join(' ')}` });
      self.postMessage({ type: 'READY' });

      qemuModule.callMain(qemuArgs);
    } catch (err) {
      isRunning = false;
      self.postMessage({ type: 'ERROR', text: err && err.stack ? err.stack : String(err) });
    }
  }
};
