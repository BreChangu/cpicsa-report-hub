import { Injectable } from '@angular/core';
import { createWorker, PSM } from 'tesseract.js';

interface OcrVariant {
  blob: Blob;
  name: string;
  psms: PSM[];
}

interface OcrCandidate {
  text: string;
  score: number;
}

@Injectable({
  providedIn: 'root'
})
export class OcrService {
  async extractTextFromImage(imageSource: string | File | Blob): Promise<{ text: string }> {
    const { image, cleanup } = await this.loadImageFromSource(imageSource);
    const variants = await this.buildOcrVariants(image);
    const worker = await createWorker('spa');

    try {
      const candidates: OcrCandidate[] = [];

      for (const variant of variants) {
        for (const psm of variant.psms) {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            tessedit_char_blacklist: '|¦«»[]{}<>',
            preserve_interword_spaces: '1',
            user_defined_dpi: '300'
          });

          const { data } = await worker.recognize(variant.blob);
          const text = this.extractCandidateText(data);

          if (!text) {
            continue;
          }

          candidates.push({
            text,
            score: this.scoreCandidate(text, data.confidence ?? 0, variant.name, psm)
          });
        }
      }

      const bestCandidate = candidates.sort((left, right) => right.score - left.score)[0];

      return {
        text: bestCandidate?.text ?? ''
      };
    } finally {
      await worker.terminate();
      cleanup();
    }
  }

  private async loadImageFromSource(imageSource: string | File | Blob): Promise<{
    image: HTMLImageElement;
    cleanup: () => void;
  }> {
    const sourceUrl = typeof imageSource === 'string'
      ? imageSource
      : URL.createObjectURL(imageSource);

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('No se pudo cargar la imagen para OCR.'));
      nextImage.src = sourceUrl;
    });

    return {
      image,
      cleanup: () => {
        if (typeof imageSource !== 'string') {
          URL.revokeObjectURL(sourceUrl);
        }
      }
    };
  }

  private async buildOcrVariants(image: HTMLImageElement): Promise<OcrVariant[]> {
    return [
      {
        name: 'full-binary',
        blob: await this.renderVariant(image, { region: 'full', mode: 'binary' }),
        psms: [PSM.SPARSE_TEXT]
      },
      {
        name: 'full-contrast',
        blob: await this.renderVariant(image, { region: 'full', mode: 'contrast' }),
        psms: [PSM.SPARSE_TEXT]
      },
      {
        name: 'footer-binary',
        blob: await this.renderVariant(image, { region: 'footer', mode: 'binary' }),
        psms: [PSM.SINGLE_LINE, PSM.SPARSE_TEXT]
      },
      {
        name: 'footer-contrast',
        blob: await this.renderVariant(image, { region: 'footer', mode: 'contrast' }),
        psms: [PSM.SINGLE_LINE]
      }
    ];
  }

  private async renderVariant(
    image: HTMLImageElement,
    options: { region: 'full' | 'footer'; mode: 'binary' | 'contrast' }
  ): Promise<Blob> {
    const cropSource = this.resolveCropRegion(image, options.region);
    const scale = cropSource.width < 1200 ? 2 : 1.4;
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(Math.round(cropSource.width * scale), 1);
    canvas.height = Math.max(Math.round(cropSource.height * scale), 1);

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('No se pudo crear el contexto del canvas para OCR.');
    }

    context.drawImage(
      image,
      cropSource.x,
      cropSource.y,
      cropSource.width,
      cropSource.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const threshold = this.calculateOtsuThreshold(imageData.data);

    for (let index = 0; index < imageData.data.length; index += 4) {
      const luminance = this.calculateLuminance(
        imageData.data[index],
        imageData.data[index + 1],
        imageData.data[index + 2]
      );

      if (options.mode === 'binary') {
        const binaryValue = luminance > threshold ? 255 : 0;
        imageData.data[index] = binaryValue;
        imageData.data[index + 1] = binaryValue;
        imageData.data[index + 2] = binaryValue;
      } else {
        const contrasted = luminance > threshold
          ? Math.min(255, luminance + 36)
          : Math.max(0, luminance - 42);

        imageData.data[index] = contrasted;
        imageData.data[index + 1] = contrasted;
        imageData.data[index + 2] = contrasted;
      }

      imageData.data[index + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) {
          reject(new Error('No se pudo serializar la imagen para OCR.'));
          return;
        }

        resolve(blob);
      }, 'image/png');
    });
  }

  private resolveCropRegion(image: HTMLImageElement, region: 'full' | 'footer') {
    if (region === 'full') {
      return {
        x: 0,
        y: 0,
        width: image.naturalWidth,
        height: image.naturalHeight
      };
    }

    const footerHeight = Math.max(Math.round(image.naturalHeight * 0.24), 120);

    return {
      x: 0,
      y: Math.max(image.naturalHeight - footerHeight, 0),
      width: image.naturalWidth,
      height: Math.min(footerHeight, image.naturalHeight)
    };
  }

  private calculateOtsuThreshold(pixelData: Uint8ClampedArray): number {
    const histogram = new Array<number>(256).fill(0);
    const pixelCount = pixelData.length / 4;

    for (let index = 0; index < pixelData.length; index += 4) {
      const luminance = Math.round(
        this.calculateLuminance(
          pixelData[index],
          pixelData[index + 1],
          pixelData[index + 2]
        )
      );

      histogram[luminance] += 1;
    }

    let sum = 0;
    for (let index = 0; index < histogram.length; index++) {
      sum += index * histogram[index];
    }

    let sumBackground = 0;
    let weightBackground = 0;
    let maximumVariance = 0;
    let threshold = 160;

    for (let index = 0; index < histogram.length; index++) {
      weightBackground += histogram[index];
      if (!weightBackground) {
        continue;
      }

      const weightForeground = pixelCount - weightBackground;
      if (!weightForeground) {
        break;
      }

      sumBackground += index * histogram[index];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

      if (variance > maximumVariance) {
        maximumVariance = variance;
        threshold = index;
      }
    }

    return threshold;
  }

  private calculateLuminance(red: number, green: number, blue: number): number {
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  private extractCandidateText(data: any): string {
    const confidentWords = (data?.blocks ?? [])
      .flatMap((block: any) => block.paragraphs ?? [])
      .flatMap((paragraph: any) => paragraph.lines ?? [])
      .flatMap((line: any) => line.words ?? [])
      .filter((word: any) => {
        const normalized = this.sanitizeText(String(word.text ?? ''));
        return word.confidence >= 52 && /[\p{L}\p{N}]/u.test(normalized);
      })
      .map((word: any) => this.sanitizeText(String(word.text ?? '')))
      .filter(Boolean);

    const text = confidentWords.length
      ? confidentWords.join(' ')
      : this.sanitizeText(String(data?.text ?? ''));

    return this.sanitizeText(text);
  }

  private scoreCandidate(text: string, confidence: number, variant: string, psm: PSM): number {
    const alphaNumericChars = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const length = text.length;
    const validRatio = length ? alphaNumericChars / length : 0;
    const footerBonus = variant.startsWith('footer') ? 9 : 0;
    const lineBonus = psm === PSM.SINGLE_LINE ? 6 : 0;
    const compactnessPenalty = length > 90 ? (length - 90) * 0.12 : 0;

    return confidence * 0.8 + validRatio * 28 + footerBonus + lineBonus - compactnessPenalty;
  }

  private sanitizeText(text: string): string {
    return text
      .replace(/[|¦«»]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s:;,.()/%+\-#]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
