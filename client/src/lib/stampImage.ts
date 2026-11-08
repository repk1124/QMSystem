/**
 * 印章圖片處理。
 *
 * 使用者上傳的印章通常是手機拍的或掃描的照片：白底、幾 MB、尺寸很大。
 * 直接蓋在報價單上會是一塊白色方塊，所以上傳到伺服器前先在瀏覽器端處理。
 *
 * 這裡在瀏覽器端做三件事：
 *   1. 縮到合理尺寸（預設寬 440px，足夠 A4 上 30mm 的清晰度）
 *   2. 自動去背：把接近白色的像素轉成透明
 *   3. 輸出 PNG data URL，讓 html2canvas 不會因跨來源圖片汙染 canvas
 */

export interface PrepareStampOptions {
  /** 輸出寬度（px） */
  maxWidth?: number;
  /**
   * 去背門檻（0–255）。亮度高於此值的像素會被視為背景轉為透明。
   * 值越高去得越保守。設為 0 可完全停用去背。
   */
  whiteThreshold?: number;
}

export interface PreparedStamp {
  dataUrl: string;
  width: number;
  height: number;
  /** 產生後的位元組數（約略，用於提示使用者是否過大） */
  approxBytes: number;
}

const DEFAULT_MAX_WIDTH = 440;
const DEFAULT_WHITE_THRESHOLD = 215;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取圖片檔案'));
    };
    img.src = url;
  });
}

export async function prepareStampImage(
  file: File,
  options: PrepareStampOptions = {},
): Promise<PreparedStamp> {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const whiteThreshold = options.whiteThreshold ?? DEFAULT_WHITE_THRESHOLD;

  if (!file.type.startsWith('image/')) {
    throw new Error('請選擇圖片檔案（PNG 或 JPG）');
  }

  const img = await loadImage(file);

  const scale = img.width > maxWidth ? maxWidth / img.width : 1;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器不支援圖片處理');

  ctx.drawImage(img, 0, 0, width, height);

  if (whiteThreshold > 0) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // 感知亮度
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luminance >= whiteThreshold) {
        data[i + 3] = 0; // 純背景，完全透明
      } else if (luminance > whiteThreshold - 60) {
        // 邊緣過渡帶：依亮度做漸進透明，避免鋸齒
        const ratio = (whiteThreshold - luminance) / 60;
        data[i + 3] = Math.round(data[i + 3] * ratio);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  const dataUrl = canvas.toDataURL('image/png');

  return {
    dataUrl,
    width,
    height,
    // data URL 是 base64，實際位元組約為長度的 3/4
    approxBytes: Math.round((dataUrl.length - 'data:image/png;base64,'.length) * 0.75),
  };
}

/**
 * 把伺服器上的印章（/api/settings/stamp）抓回來轉成 data URL。
 * html2canvas 對同源 <img> 其實可以直接用，但轉成 data URL 最保險，
 * 也避免列印用的 iframe 再打一次 API。抓不到就回 undefined（PDF 照出，只是不蓋章）。
 */
export async function loadStampDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}
