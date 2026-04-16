import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageCroppedEvent, ImageCropperComponent } from 'ngx-image-cropper';
import { OcrService } from './core/services/ocr.service';
import { SmartDropzoneComponent } from './shared/ui/smart-dropzone/smart-dropzone';

type DocxModule = typeof import('docx');
type JsPdfModule = typeof import('jspdf');

export interface EvidenceItem {
  id: string;
  sourceFile: File;
  reportFile: File;
  previewUrl: string;
  description: string;
  capturedDate: string;
  selected: boolean;
  isProcessing: boolean;
  isCropped: boolean;
  showCropper: boolean;
  croppedBlob?: Blob;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SmartDropzoneComponent,
    ImageCropperComponent
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.scss']
})
export class App implements OnDestroy {
  private readonly ocrService = inject(OcrService);
  private readonly managedPreviewUrls = new Set<string>();

  evidences = signal<EvidenceItem[]>([]);
  previewingEvidence = signal<EvidenceItem | null>(null);
  isGeneratingWord = signal(false);
  isGeneratingPdf = signal(false);
  bulkCapturedDate = signal(this.getTodayDateInputValue());

  async onFilesReceived(files: File[]) {
    for (const file of files) {
      const evidenceId = crypto.randomUUID();

      this.evidences.update(current => [
        {
          id: evidenceId,
          sourceFile: file,
          reportFile: file,
          previewUrl: this.createPreviewUrl(file),
          description: '',
          capturedDate: this.getTodayDateInputValue(),
          selected: false,
          isProcessing: true,
          isCropped: false,
          showCropper: false
        },
        ...current
      ]);

      await this.processEvidenceText(evidenceId, file);
    }
  }

  onImageCropped(event: ImageCroppedEvent, id: string) {
    if (!event.blob) {
      return;
    }

    this.evidences.update(current =>
      current.map(item =>
        item.id === id
          ? { ...item, croppedBlob: event.blob ?? undefined }
          : item
      )
    );
  }

  confirmCrop(id: string) {
    let previousPreviewUrl: string | undefined;

    this.evidences.update(current =>
      current.map(item => {
        if (item.id !== id) {
          return item;
        }

        if (!item.croppedBlob) {
          return {
            ...item,
            showCropper: false
          };
        }

        previousPreviewUrl = item.previewUrl;
        const croppedFile = new File(
          [item.croppedBlob],
          this.buildCroppedFileName(item.reportFile),
          {
            type: item.croppedBlob.type || item.reportFile.type,
            lastModified: Date.now()
          }
        );

        return {
          ...item,
          reportFile: croppedFile,
          previewUrl: this.createPreviewUrl(croppedFile),
          isCropped: true,
          showCropper: false,
          croppedBlob: undefined
        };
      })
    );

    if (previousPreviewUrl) {
      this.revokePreviewUrl(previousPreviewUrl);
    }
  }

  toggleCropper(id: string) {
    this.evidences.update(current =>
      current.map(item =>
        item.id === id
          ? {
              ...item,
              showCropper: !item.showCropper,
              croppedBlob: item.showCropper ? undefined : item.croppedBlob
            }
          : item
      )
    );
  }

  async reprocessEvidenceText(id: string) {
    const evidence = this.evidences().find(item => item.id === id);
    if (!evidence || evidence.isProcessing) {
      return;
    }

    await this.processEvidenceText(id, evidence.sourceFile);
  }

  deleteEvidence(id: string) {
    const evidence = this.evidences().find(item => item.id === id);
    if (!evidence) {
      return;
    }

    this.evidences.update(current => current.filter(item => item.id !== id));
    this.revokePreviewUrl(evidence.previewUrl);

    if (this.previewingEvidence()?.id === id) {
      this.closePreview();
    }
  }

  toggleEvidenceSelection(id: string) {
    this.evidences.update(current =>
      current.map(item =>
        item.id === id
          ? { ...item, selected: !item.selected }
          : item
      )
    );
  }

  toggleSelectAll(checked: boolean) {
    this.evidences.update(current =>
      current.map(item => ({
        ...item,
        selected: checked
      }))
    );
  }

  hasSelectedEvidences() {
    return this.evidences().some(item => item.selected);
  }

  areAllSelected() {
    const items = this.evidences();
    return items.length > 0 && items.every(item => item.selected);
  }

  selectedCount() {
    return this.evidences().filter(item => item.selected).length;
  }

  applyBulkCapturedDate() {
    const date = this.bulkCapturedDate();
    if (!date) {
      return;
    }

    this.evidences.update(current =>
      current.map(item =>
        item.selected
          ? { ...item, capturedDate: date }
          : item
      )
    );
  }

  openPreview(item: EvidenceItem) {
    if (!item.previewUrl) {
      return;
    }

    this.previewingEvidence.set(item);
  }

  closePreview() {
    this.previewingEvidence.set(null);
  }

  @HostListener('window:keydown.escape')
  onEscapeKey() {
    this.closePreview();
  }

  async generateWordReport() {
    const evidences = this.evidences();
    if (!evidences.length || this.isGeneratingWord()) {
      return;
    }

    this.isGeneratingWord.set(true);

    try {
      const docx = await import('docx');
      const document = await this.buildWordDocument(evidences, docx);
      const blob = await docx.Packer.toBlob(document);
      this.downloadBlob(blob, this.buildReportFileName('docx'));
    } finally {
      this.isGeneratingWord.set(false);
    }
  }

  async generatePdfReport() {
    const evidences = this.evidences();
    if (!evidences.length || this.isGeneratingPdf()) {
      return;
    }

    this.isGeneratingPdf.set(true);

    try {
      const { jsPDF } = await import('jspdf') as JsPdfModule;
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pages = this.chunkItems(evidences, 4);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        if (pageIndex > 0) {
          pdf.addPage();
        }

        this.drawPdfHeader(pdf);

        const pageItems = pages[pageIndex];
        for (let itemIndex = 0; itemIndex < pageItems.length; itemIndex++) {
          await this.drawPdfEvidenceCard(pdf, pageItems[itemIndex], pageIndex * 4 + itemIndex, itemIndex);
        }

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.setTextColor(90, 104, 124);
        pdf.text(`Pagina ${pageIndex + 1}`, 105, 287, { align: 'center' });
      }

      pdf.save(this.buildReportFileName('pdf'));
    } finally {
      this.isGeneratingPdf.set(false);
    }
  }

  ngOnDestroy() {
    for (const url of this.managedPreviewUrls) {
      URL.revokeObjectURL(url);
    }

    this.managedPreviewUrls.clear();
  }

  private async processEvidenceText(id: string, file: File) {
    this.evidences.update(current =>
      current.map(item =>
        item.id === id
          ? { ...item, isProcessing: true }
          : item
      )
    );

    try {
      const result = await this.ocrService.extractTextFromImage(file);

      this.evidences.update(current =>
        current.map(item =>
          item.id === id
            ? {
                ...item,
                description: result.text || item.description,
                isProcessing: false
              }
            : item
        )
      );
    } catch {
      this.evidences.update(current =>
        current.map(item =>
          item.id === id
            ? { ...item, isProcessing: false }
            : item
        )
      );
    }
  }

  private async buildWordDocument(evidences: EvidenceItem[], docx: DocxModule) {
    const {
      AlignmentType,
      BorderStyle,
      Document,
      Paragraph,
      Table,
      TableCell,
      TableLayoutType,
      TableRow,
      TextRun,
      VerticalAlign,
      WidthType
    } = docx;

    const pages = this.chunkItems(evidences, 4);

    const sections = await Promise.all(
      pages.map(async (pageItems, pageIndex) => {
        const rows = await Promise.all(
          [0, 1].map(async rowIndex => {
            const cells = await Promise.all(
              [0, 1].map(async columnIndex => {
                const item = pageItems[rowIndex * 2 + columnIndex];
                const evidenceIndex = pageIndex * 4 + rowIndex * 2 + columnIndex;

                return new TableCell({
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  verticalAlign: VerticalAlign.TOP,
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 1, color: '7A8799' },
                    bottom: { style: BorderStyle.SINGLE, size: 1, color: '7A8799' },
                    left: { style: BorderStyle.SINGLE, size: 1, color: '7A8799' },
                    right: { style: BorderStyle.SINGLE, size: 1, color: '7A8799' }
                  },
                  margins: {
                    top: 160,
                    bottom: 160,
                    left: 160,
                    right: 160
                  },
                  children: item
                    ? await this.buildWordCellChildren(item, evidenceIndex, docx)
                    : [new Paragraph('')]
                });
              })
            );

            return new TableRow({
              children: cells
            });
          })
        );

        return {
          properties: {
            page: {
              margin: {
                top: 540,
                bottom: 540,
                left: 540,
                right: 540
              }
            }
          },
          children: [
            this.buildWordHeaderLeft(docx),
            this.buildWordHeaderRight(docx),
            new Paragraph({ spacing: { after: 150 } }),
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              layout: TableLayoutType.FIXED,
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
              },
              columnWidths: [4500, 4500],
              rows
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 150 },
              children: [
                new TextRun({
                  text: `Pagina ${pageIndex + 1}`,
                  size: 18,
                  color: '4B5563'
                })
              ]
            }),
            this.buildWordFooter(docx)
          ]
        };
      })
    );

    return new Document({
      sections
    });
  }

  private buildWordHeaderLeft(docx: DocxModule) {
    const { AlignmentType, Paragraph, TextRun } = docx;

    return new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 20 },
      children: [
        new TextRun({
          text: 'CPICSA',
          bold: true,
          color: '119FDA',
          size: 36
        }),
        new TextRun({
          text: '\nCONTROL DE PLAGAS INTERNACIONAL',
          break: 1,
          bold: true,
          color: '168B43',
          size: 15
        }),
        new TextRun({
          text: '\nCENTINELA, S.A. DE C.V.',
          break: 1,
          bold: true,
          color: '168B43',
          size: 15
        }),
        new TextRun({
          text: '\nwww.cpicsa.com',
          break: 1,
          color: '119FDA',
          size: 14
        })
      ]
    });
  }

  private buildWordHeaderRight(docx: DocxModule) {
    const { AlignmentType, Paragraph, TextRun } = docx;

    return new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 170 },
      children: [
        new TextRun({
          text: 'PLANTA TEMAXCAL No. 2A',
          bold: true,
          color: '119FDA',
          size: 14
        }),
        new TextRun({
          text: '\nCOL. ELECTRA, C.P. 54060',
          break: 1,
          bold: true,
          color: '119FDA',
          size: 14
        }),
        new TextRun({
          text: '\nTLALNEPANTLA ESTADO DE MEXICO',
          break: 1,
          bold: true,
          color: '119FDA',
          size: 14
        })
      ]
    });
  }

  private buildWordFooter(docx: DocxModule) {
    const { AlignmentType, Paragraph, TextRun } = docx;

    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 140 },
      children: [
        new TextRun({
          text: 'contacto@cpicsa.com   |   www.cpicsa.com   |   Tel:(55) 5365 11 80 / Tel:(55) 5361 31 84',
          color: '4B5563',
          size: 16
        })
      ]
    });
  }

  private async buildWordCellChildren(item: EvidenceItem, evidenceIndex: number, docx: DocxModule) {
    const { AlignmentType, BorderStyle, ImageRun, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = docx;
    const imageBuffer = await this.getReportImageFile(item).arrayBuffer();
    const dimensions = await this.getScaledImageDimensions(this.getReportImageFile(item), 220, 130);

    return [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: [1300, 3200],
        rows: [
          new TableRow({
            children: [
              new TableCell({
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  left: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  right: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' }
                },
                margins: { top: 60, bottom: 60, left: 80, right: 80 },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: this.formatCapturedDate(item.capturedDate),
                        bold: true,
                        size: 18
                      })
                    ]
                  })
                ]
              }),
              new TableCell({
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  left: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' },
                  right: { style: BorderStyle.SINGLE, size: 1, color: '5E6774' }
                },
                margins: { top: 60, bottom: 60, left: 80, right: 80 },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: `${evidenceIndex + 1}.- `,
                        bold: true,
                        size: 19
                      }),
                      new TextRun({
                        text: (item.description.trim() || 'SIN DESCRIPCION CAPTURADA.').toUpperCase(),
                        size: 19
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      new Paragraph({ spacing: { after: 70 } }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 50 },
        children: [
          new ImageRun({
            type: this.getDocxImageType(this.getReportImageFile(item).type),
            data: imageBuffer,
            transformation: dimensions
          })
        ]
      }),
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 30 },
        children: [
          new TextRun({
            text: item.isCropped ? 'Imagen recortada' : 'Imagen original',
            italics: true,
            color: '6B7280',
            size: 15
          })
        ]
      })
    ];
  }

  private drawPdfHeader(pdf: InstanceType<JsPdfModule['jsPDF']>) {
    pdf.setTextColor(17, 159, 218);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(28);
    pdf.text('CPICSA', 10, 14);

    pdf.setTextColor(22, 139, 67);
    pdf.setFontSize(8);
    pdf.text('CONTROL DE PLAGAS INTERNACIONAL', 10, 19);
    pdf.text('CENTINELA, S.A. DE C.V.', 10, 22.5);

    pdf.setTextColor(17, 159, 218);
    pdf.setFontSize(8);
    pdf.text('www.cpicsa.com', 15, 26.5);

    pdf.setFontSize(7);
    pdf.text('PLANTA TEMAXCAL No. 2A', 200, 12, { align: 'right' });
    pdf.text('COL. ELECTRA, C.P. 54060', 200, 15.2, { align: 'right' });
    pdf.text('TLALNEPANTLA ESTADO DE MEXICO', 200, 18.4, { align: 'right' });
  }

  private async drawPdfEvidenceCard(
    pdf: InstanceType<JsPdfModule['jsPDF']>,
    item: EvidenceItem,
    absoluteIndex: number,
    indexOnPage: number
  ) {
    const positions = [
      { x: 10, y: 36 },
      { x: 105, y: 36 },
      { x: 10, y: 149 },
      { x: 105, y: 149 }
    ];
    const { x, y } = positions[indexOnPage];
    const cardWidth = 95;
    const cardHeight = 103;
    const imageY = y + 15;
    const imageHeight = 72;

    pdf.setDrawColor(94, 103, 116);
    pdf.setLineWidth(0.35);
    pdf.rect(x, y, cardWidth, cardHeight);
    pdf.rect(x, y, 22, 7.5);
    pdf.rect(x + 22, y, cardWidth - 22, 16);

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    pdf.setTextColor(0, 0, 0);
    pdf.text(this.formatCapturedDate(item.capturedDate), x + 11, y + 5.2, { align: 'center' });

    const titleLines = pdf.splitTextToSize(
      `${absoluteIndex + 1}.- ${(item.description.trim() || 'SIN DESCRIPCION CAPTURADA.').toUpperCase()}`,
      cardWidth - 26
    );
    pdf.text(titleLines, x + 24, y + 5.8);

    const imageDataUrl = await this.fileToDataUrl(this.getReportImageFile(item));
    const dimensions = await this.getScaledImageDimensions(this.getReportImageFile(item), 84, imageHeight);
    const imageX = x + (cardWidth - dimensions.width) / 2;
    const finalImageY = imageY + (imageHeight - dimensions.height) / 2;

    pdf.addImage(
      imageDataUrl,
      this.mapMimeTypeToPdfFormat(this.getReportImageFile(item).type),
      imageX,
      finalImageY,
      dimensions.width,
      dimensions.height
    );

    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(7.5);
    pdf.setTextColor(90, 104, 124);
    pdf.text(item.isCropped ? 'Imagen recortada' : 'Imagen original', x + cardWidth / 2, y + 93, {
      align: 'center'
    });
  }

  private async getScaledImageDimensions(file: File, maxWidth: number, maxHeight: number) {
    const objectUrl = URL.createObjectURL(file);

    try {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();

        image.onload = () => {
          resolve({
            width: image.naturalWidth,
            height: image.naturalHeight
          });
        };

        image.onerror = () => reject(new Error(`No se pudo leer la imagen ${file.name}.`));
        image.src = objectUrl;
      });

      const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height, 1);

      return {
        width: Math.max(Number((dimensions.width * scale).toFixed(2)), 25),
        height: Math.max(Number((dimensions.height * scale).toFixed(2)), 25)
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  private createPreviewUrl(file: Blob): string {
    const previewUrl = URL.createObjectURL(file);
    this.managedPreviewUrls.add(previewUrl);
    return previewUrl;
  }

  private revokePreviewUrl(url: string) {
    if (!this.managedPreviewUrls.has(url)) {
      return;
    }

    URL.revokeObjectURL(url);
    this.managedPreviewUrls.delete(url);
  }

  private buildCroppedFileName(file: File): string {
    const extension = file.type.split('/')[1] || 'png';
    const baseName = file.name.replace(/\.[^.]+$/, '');
    return `${baseName}-crop.${extension}`;
  }

  private getReportImageFile(item: EvidenceItem) {
    return item.reportFile;
  }

  private getDocxImageType(mimeType: string): 'jpg' | 'png' | 'gif' | 'bmp' {
    if (mimeType.includes('png')) {
      return 'png';
    }

    if (mimeType.includes('gif')) {
      return 'gif';
    }

    if (mimeType.includes('bmp')) {
      return 'bmp';
    }

    return 'jpg';
  }

  private mapMimeTypeToPdfFormat(mimeType: string): 'JPEG' | 'PNG' | 'WEBP' {
    if (mimeType.includes('png')) {
      return 'PNG';
    }

    if (mimeType.includes('webp')) {
      return 'WEBP';
    }

    return 'JPEG';
  }

  private async fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private downloadBlob(blob: Blob, fileName: string) {
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = downloadUrl;
    anchor.download = fileName;
    anchor.click();

    URL.revokeObjectURL(downloadUrl);
  }

  private buildReportFileName(extension: 'docx' | 'pdf') {
    const now = new Date();
    const dateStamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');

    return `reporte-evidencias-${dateStamp}.${extension}`;
  }

  private formatCapturedDate(value: string) {
    if (!value) {
      return this.formatDateForBadge(this.getTodayDateInputValue());
    }

    return this.formatDateForBadge(value);
  }

  private formatDateForBadge(value: string) {
    const [year, month, day] = value.split('-');
    if (!year || !month || !day) {
      return value;
    }

    return `${day}/${month}/${year}`;
  }

  private getTodayDateInputValue() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');
  }

  private chunkItems<T>(items: T[], size: number) {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }
}
