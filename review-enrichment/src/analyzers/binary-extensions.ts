// Shared binary-file extension inventory for analyzers that classify opaque blobs by path extension.
// asset-weight.ts (size bloat) and provenance.ts (unauditable committed artifacts) must stay in parity —
// a single source list prevents one analyzer from drifting and missing formats the other already flags.

/** Lowercase extensions for genuinely binary assets. Text formats like .svg/.json are excluded. */
export const BINARY_FILE_EXTENSIONS = [
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "webp",
  "avif",
  "heic",
  "heif",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Media
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "flac",
  "ogg",
  // Archives / compression
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "zst",
  "lz4",
  "br",
  // Documents / design
  "pdf",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xcf",
  // Native / compiled
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "wasm",
  "node",
  "jar",
  "class",
  "pyc",
  "pyo",
  "pyd",
  "o",
  "a",
  "war",
  "ear",
  // ML checkpoints
  "safetensors",
  "gguf",
  "onnx",
  "pt",
  "pth",
  "ckpt",
  // Scientific / ML data artifacts
  "h5",
  "hdf5",
  "pb",
  "npy",
  "npz",
  "parquet",
  "feather",
  "arrow",
  "orc",
  "msgpack",
  // More common binary formats: audio/video containers, disk images, and ML artifacts.
  "m4a",
  "m4v",
  "aac",
  "opus",
  "wma",
  "aiff",
  "flv",
  "wmv",
  "iso",
  "dmg",
  "pkl",
  "pickle",
  "joblib",
  "tflite",
  "keras",
] as const;

const BINARY_EXT_SET = new Set<string>(BINARY_FILE_EXTENSIONS);

/** True when `ext` (without a leading dot) is a known binary file extension. Case-insensitive. Pure. */
export function isBinaryFileExtension(ext: string): boolean {
  return BINARY_EXT_SET.has(ext.toLowerCase());
}

/** Extension-anchored, case-insensitive regex matching any shared binary extension at path end. Pure. */
export const BINARY_EXT_RE = new RegExp(
  `\\.(?:${BINARY_FILE_EXTENSIONS.join("|")})$`,
  "i",
);
