import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, inject, signal, ViewChild, computed } from '@angular/core';
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
  category: string;
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

  @ViewChild(ImageCropperComponent) cropper!: ImageCropperComponent;

  evidences = signal<EvidenceItem[]>([]);
  previewingEvidence = signal<EvidenceItem | null>(null);
  isGeneratingWord = signal(false);
  isGeneratingPdf = signal(false);
  
  bulkCapturedDate = signal(this.getTodayDateInputValue());
  reportTitle = signal('');

  // LÓGICA DE CATEGORÍAS LIBRES
  bulkCategory = signal(''); // Para asignar
  filterCategory = signal(''); // Para seleccionar (NUEVO)
  
  dynamicCategories = computed(() => {
    const cats = new Set<string>(['MANTENIMIENTO']); 
    this.evidences().forEach(e => {
      if (e.category && e.category.trim() !== '') {
        cats.add(e.category.trim().toUpperCase());
      }
    });
    return Array.from(cats);
  });

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
          category: 'MANTENIMIENTO', // Por defecto
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
    if (!event.blob) return;
    this.evidences.update(current => current.map(item => item.id === id ? { ...item, croppedBlob: event.blob ?? undefined } : item));
  }

  confirmCrop(id: string) {
    let previousPreviewUrl: string | undefined;
    this.evidences.update(current =>
      current.map(item => {
        if (item.id !== id) return item;
        if (!item.croppedBlob) return { ...item, showCropper: false };

        previousPreviewUrl = item.previewUrl;
        
        const croppedFile = new File(
          [item.croppedBlob],
          this.buildCroppedFileName(item.reportFile),
          { type: item.croppedBlob.type || item.reportFile.type, lastModified: Date.now() }
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

    if (previousPreviewUrl) this.revokePreviewUrl(previousPreviewUrl);
  }

  toggleCropper(id: string) {
    this.evidences.update(current => current.map(item => item.id === id ? { ...item, showCropper: !item.showCropper, croppedBlob: item.showCropper ? undefined : item.croppedBlob } : item));
  }

  async reprocessEvidenceText(id: string) {
    const evidence = this.evidences().find(item => item.id === id);
    if (!evidence || evidence.isProcessing) return;
    await this.processEvidenceText(id, evidence.sourceFile);
  }

  deleteEvidence(id: string) {
    const evidence = this.evidences().find(item => item.id === id);
    if (!evidence) return;
    this.evidences.update(current => current.filter(item => item.id !== id));
    this.revokePreviewUrl(evidence.previewUrl);
    if (this.previewingEvidence()?.id === id) this.closePreview();
  }

  toggleEvidenceSelection(id: string) {
    this.evidences.update(current => current.map(item => item.id === id ? { ...item, selected: !item.selected } : item));
  }

  toggleSelectAll(checked: boolean) {
    this.evidences.update(current => current.map(item => ({ ...item, selected: checked })));
  }

  hasSelectedEvidences() { return this.evidences().some(item => item.selected); }
  areAllSelected() { const items = this.evidences(); return items.length > 0 && items.every(item => item.selected); }
  selectedCount() { return this.evidences().filter(item => item.selected).length; }

  applyBulkCapturedDate() {
    const date = this.bulkCapturedDate();
    if (!date) return;
    this.evidences.update(current => current.map(item => item.selected ? { ...item, capturedDate: date } : item));
  }

  // 👇 LÓGICA DE SELECCIÓN REPARADA 👇
  selectByCategory() {
    const targetCat = this.filterCategory().trim().toUpperCase();
    if (!targetCat) return;
    this.evidences.update(current => 
      current.map(item => ({
        ...item,
        selected: (item.category || '').trim().toUpperCase() === targetCat
      }))
    );
  }

  applyBulkCategory() {
    const cat = this.bulkCategory().trim().toUpperCase();
    if (!cat) return;
    this.evidences.update(current => current.map(item => item.selected ? { ...item, category: cat } : item));
  }

  openPreview(item: EvidenceItem) {
    if (!item.previewUrl) return;
    this.previewingEvidence.set(item);
  }

  closePreview() { this.previewingEvidence.set(null); }

  @HostListener('window:keydown.escape')
  onEscapeKey() { this.closePreview(); }

  // --- MOTOR PDF B2B PREMIUM ---
  async generatePdfReport() {
    const evidences = this.evidences();
    if (!evidences.length || this.isGeneratingPdf()) return;
    this.isGeneratingPdf.set(true);

    try {
      const { jsPDF } = await import('jspdf') as JsPdfModule;
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      
      let isFirstPageOverall = true;
      let globalPageNum = 1;

      const groupedEvidences = this.groupByCategory(evidences);
      
      const sortedCategories = Object.keys(groupedEvidences).sort((a, b) => {
        if (a === 'MANTENIMIENTO') return -1;
        if (b === 'MANTENIMIENTO') return 1;
        return a.localeCompare(b);
      });

      for (const category of sortedCategories) {
        const items = groupedEvidences[category];
        const chunks = this.chunkItems(items, 2);

        for (let i = 0; i < chunks.length; i++) {
          if (!isFirstPageOverall) pdf.addPage();
          isFirstPageOverall = false;
          
          this.drawElegantHeader(pdf);

          const hasTitle = this.reportTitle().trim().length > 0;
          
          if (i === 0 && hasTitle) {
            pdf.setFontSize(13);
            pdf.setTextColor(15, 23, 42); 
            pdf.setFont('helvetica', 'bold');
            pdf.text(`${this.reportTitle().toUpperCase()} - ${category}`, 15, 38);
            
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9);
            pdf.setTextColor(100, 116, 139); 
            pdf.text(`Emitido: ${this.formatCapturedDate(this.getTodayDateInputValue())}`, 282, 38, { align: 'right' });
          }

          const pageItems = chunks[i];
          const startY = (i === 0 && hasTitle) ? 44 : 34;
          const cardHeight = 145; 
          const cardWidth = 130;

          const itemLeft = pageItems[0];
          const itemRight = pageItems[1];

          if (itemLeft) {
            const linesLeft = this.getSplitLines(pdf, itemLeft, (i * 2) + 0, cardWidth);
            const linesRight = itemRight ? this.getSplitLines(pdf, itemRight, (i * 2) + 1, cardWidth) : [];

            const maxLinesInRow = Math.max(linesLeft.length, linesRight.length);

            await this.drawElegantCard(pdf, itemLeft, linesLeft, maxLinesInRow, 15, startY, cardWidth, cardHeight);
            if (itemRight) {
              await this.drawElegantCard(pdf, itemRight, linesRight, maxLinesInRow, 152, startY, cardWidth, cardHeight);
            }
          }

          this.drawElegantFooter(pdf, globalPageNum);
          globalPageNum++;
        }
      }
      pdf.save(this.buildReportFileName('pdf'));
    } finally {
      this.isGeneratingPdf.set(false);
    }
  }

  private drawElegantHeader(pdf: any) {
    pdf.setTextColor(0, 160, 227); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(22); pdf.text('CPICSA', 15, 16);
    pdf.setTextColor(141, 198, 63); pdf.setFontSize(7.5); pdf.text('CONTROL DE PLAGAS INTERNACIONAL', 15, 20.5); pdf.text('CENTINELA, S.A. DE C.V.', 15, 23.5);
    pdf.setTextColor(71, 85, 105); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
    pdf.text('PLANTA TEMAXCAL No. 2A', 282, 15, { align: 'right' }); pdf.text('COL. ELECTRA, C.P. 54060', 282, 18.5, { align: 'right' }); pdf.text('TLALNEPANTLA, ESTADO DE MÉXICO', 282, 22, { align: 'right' });
    pdf.setDrawColor(226, 232, 240); pdf.setLineWidth(0.2); pdf.line(15, 27, 282, 27);
  }

  private getSplitLines(pdf: any, item: EvidenceItem, absoluteIndex: number, cardWidth: number): string[] {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    const rawText = `${absoluteIndex + 1}. ${(item.description.trim() || 'Sin descripción').toUpperCase()}`;
    const safeText = rawText.replace(/(.{60})/g, "$1 "); 
    return pdf.splitTextToSize(safeText, cardWidth - 8); 
  }

  private async drawElegantCard(pdf: any, item: EvidenceItem, lines: string[], maxLinesInRow: number, x: number, y: number, w: number, h: number) {
    pdf.setDrawColor(203, 213, 225); pdf.setLineWidth(0.15); pdf.rect(x, y, w, h);
    pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8); pdf.setTextColor(148, 163, 184); pdf.text(this.formatCapturedDate(item.capturedDate), x + w - 4, y + 6, { align: 'right' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(26, 34, 56); 
    
    let displayLines = [...lines];
    if (displayLines.length > 8) { displayLines = displayLines.slice(0, 8); displayLines[7] = displayLines[7].replace(/\.+$/, '') + '...'; }
    pdf.text(displayLines, x + 4, y + 11.5);

    const lineHeight = 4;
    const dynamicSeparatorY = y + 13 + (Math.min(maxLinesInRow, 8) * lineHeight);
    pdf.setDrawColor(226, 232, 240); pdf.line(x + 4, dynamicSeparatorY, x + w - 4, dynamicSeparatorY);

    const imgBoxStartY = dynamicSeparatorY + 3;
    const maxImgH = (y + h) - imgBoxStartY - 3; 

    const dataUrl = await this.fileToDataUrl(item.reportFile); 
    const dim = await this.getScaledImageDimensions(item.reportFile, w - 8, maxImgH);
    pdf.addImage(dataUrl, this.mapMimeTypeToPdfFormat(item.reportFile.type), x + (w - dim.width) / 2, imgBoxStartY + (maxImgH - dim.height) / 2, dim.width, dim.height);
  }

  private drawElegantFooter(pdf: any, pNum: number) {
    const fY = 195; 
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(100, 116, 139); 
    pdf.text('contacto@cpicsa.com', 50, fY - 3, { align: 'center' }); pdf.text('www.cpicsa.com', 148.5, fY - 3, { align: 'center' }); pdf.text('Tel: (55) 5365 11 80  |  (55) 5361 31 84', 247, fY - 3, { align: 'center' });
    const barY = fY + 1;
    pdf.setLineWidth(0.6); pdf.setDrawColor(141, 198, 63); pdf.line(15, barY, 148.5, barY); pdf.setDrawColor(0, 160, 227); pdf.line(148.5, barY, 282, barY); 
    pdf.setFontSize(7.5); pdf.setTextColor(148, 163, 184); pdf.text(`Página ${pNum}`, 148.5, 203, { align: 'center' });
  }

  private groupByCategory(items: EvidenceItem[]): Record<string, EvidenceItem[]> {
    return items.reduce((acc, item) => {
      const cat = (item.category || 'SIN SECCIÓN').trim().toUpperCase();
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    }, {} as Record<string, EvidenceItem[]>);
  }

  // --- MOTOR WORD B2B (VERTICAL) ---
  async generateWordReport() {
    const evidences = this.evidences();
    if (!evidences.length || this.isGeneratingWord()) return;
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

  private async buildWordDocument(evidences: EvidenceItem[], docx: DocxModule) {
    const { AlignmentType, BorderStyle, Document, Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType, PageOrientation } = docx;
    
    const groupedEvidences = this.groupByCategory(evidences);
    const sections: any[] = [];
    let globalPageIndex = 0;

    const sortedCategories = Object.keys(groupedEvidences).sort((a, b) => {
      if (a === 'MANTENIMIENTO') return -1;
      if (b === 'MANTENIMIENTO') return 1;
      return a.localeCompare(b);
    });

    for (const category of sortedCategories) {
      const items = groupedEvidences[category];
      const pages = this.chunkItems(items, 2);

      for (let sectionPageIndex = 0; sectionPageIndex < pages.length; sectionPageIndex++) {
        const pageItems = pages[sectionPageIndex];

        const rows = await Promise.all(
          [0, 1].map(async rowIndex => { 
            const item = pageItems[rowIndex];
            const evidenceIndex = sectionPageIndex * 2 + rowIndex; 

            return new TableRow({
              children: [
                new TableCell({
                  width: { size: 100, type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.TOP,
                  borders: { top: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, left: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, right: { style: BorderStyle.SINGLE, size: 1, color: '000000' } },
                  margins: { top: 160, bottom: 160, left: 160, right: 160 },
                  children: item ? await this.buildWordCellChildren(item, evidenceIndex, docx) : [new Paragraph('')]
                })
              ]
            });
          })
        );

        const pageChildren: any[] = [ this.buildWordHeaderLeft(docx), this.buildWordHeaderRight(docx), new Paragraph({ spacing: { after: 150 } }) ];

        if (sectionPageIndex === 0 && this.reportTitle().trim()) {
          const fullTitle = `${this.reportTitle().toUpperCase()} - ${category}`;
          pageChildren.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
              rows: [
                new TableRow({ children: [ new TableCell({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: fullTitle, bold: true, size: 22, color: '000000' })] })] }), new TableCell({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: this.formatCapturedDate(this.getTodayDateInputValue()), bold: true, size: 22, color: '000000' })] })] }) ] })
              ]
            }),
            new Paragraph({ spacing: { after: 200 } })
          );
        }

        pageChildren.push(
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, columnWidths: [9000], rows }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 150 }, children: [new TextRun({ text: `Página ${globalPageIndex + 1}`, size: 18, color: '4B5563' })] }),
          this.buildWordFooter(docx)
        );

        sections.push({ properties: { page: { margin: { top: 540, bottom: 540, left: 540, right: 540 } } }, children: pageChildren });
        globalPageIndex++;
      }
    }
    return new Document({ sections });
  }

  private buildWordHeaderLeft(docx: DocxModule) { const { AlignmentType, Paragraph, TextRun } = docx; return new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 20 }, children: [new TextRun({ text: 'CPICSA', bold: true, color: '00A0E3', size: 40 }), new TextRun({ text: '\nCONTROL DE PLAGAS INTERNACIONAL', break: 1, bold: true, color: '8DC63F', size: 15 }), new TextRun({ text: '\nCENTINELA, S.A. DE C.V.', break: 1, bold: true, color: '8DC63F', size: 15 }), new TextRun({ text: '\nwww.cpicsa.com', break: 1, color: '00A0E3', size: 14 })] }); }
  private buildWordHeaderRight(docx: DocxModule) { const { AlignmentType, Paragraph, TextRun } = docx; return new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 170 }, children: [new TextRun({ text: 'PLANTA TEMAXCAL No. 2A', bold: true, color: '00A0E3', size: 14 }), new TextRun({ text: '\nCOL. ELECTRA, C.P. 54060', break: 1, bold: true, color: '00A0E3', size: 14 }), new TextRun({ text: '\nTLALNEPANTLA ESTADO DE MEXICO', break: 1, bold: true, color: '00A0E3', size: 14 })] }); }
  private buildWordFooter(docx: DocxModule) { const { AlignmentType, Paragraph, TextRun } = docx; return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 140 }, children: [new TextRun({ text: 'contacto@cpicsa.com   |   www.cpicsa.com   |   Tel:(55) 5365 11 80 / Tel:(55) 5361 31 84', color: '4B5563', size: 16 })] }); }
  private async buildWordCellChildren(item: EvidenceItem, evidenceIndex: number, docx: DocxModule) {
    const { AlignmentType, BorderStyle, ImageRun, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = docx;
    const imageBuffer = await this.getReportImageFile(item).arrayBuffer();
    const dimensions = await this.getScaledImageDimensions(this.getReportImageFile(item), 400, 260); 

    return [
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2000, 7000], rows: [ new TableRow({ children: [ new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, left: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, right: { style: BorderStyle.SINGLE, size: 1, color: '000000' } }, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: this.formatCapturedDate(item.capturedDate), bold: true, size: 18 })] })] }), new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, left: { style: BorderStyle.SINGLE, size: 1, color: '000000' }, right: { style: BorderStyle.SINGLE, size: 1, color: '000000' } }, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [new Paragraph({ children: [new TextRun({ text: `${evidenceIndex + 1}.- `, bold: true, size: 19 }), new TextRun({ text: (item.description.trim() || 'SIN DESCRIPCIÓN CAPTURADA.').toUpperCase(), size: 19 })] })] }) ] }) ] }),
      new Paragraph({ spacing: { after: 70 } }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 50 }, children: [new ImageRun({ type: this.getDocxImageType(this.getReportImageFile(item).type), data: imageBuffer, transformation: dimensions })] })
    ];
  }

  // --- FUNCIONES AUXILIARES BASE ---
  private async processEvidenceText(id: string, file: File) { this.evidences.update(current => current.map(item => item.id === id ? { ...item, isProcessing: true } : item)); try { const result = await this.ocrService.extractTextFromImage(file); this.evidences.update(current => current.map(item => item.id === id ? { ...item, description: result.text || item.description, isProcessing: false } : item)); } catch { this.evidences.update(current => current.map(item => item.id === id ? { ...item, isProcessing: false } : item)); } }
  ngOnDestroy() { for (const url of this.managedPreviewUrls) URL.revokeObjectURL(url); this.managedPreviewUrls.clear(); }
  private async getScaledImageDimensions(file: File, maxWidth: number, maxHeight: number) { const objectUrl = URL.createObjectURL(file); try { const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error(`No se pudo leer la imagen ${file.name}.`)); image.src = objectUrl; }); const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height, 1); return { width: Math.max(Number((dimensions.width * scale).toFixed(2)), 25), height: Math.max(Number((dimensions.height * scale).toFixed(2)), 25) }; } finally { URL.revokeObjectURL(objectUrl); } }
  private createPreviewUrl(file: Blob): string { const previewUrl = URL.createObjectURL(file); this.managedPreviewUrls.add(previewUrl); return previewUrl; }
  private revokePreviewUrl(url: string) { if (!this.managedPreviewUrls.has(url)) return; URL.revokeObjectURL(url); this.managedPreviewUrls.delete(url); }
  private buildCroppedFileName(file: File): string { const extension = file.type.split('/')[1] || 'png'; const baseName = file.name.replace(/\.[^.]+$/, ''); return `${baseName}-crop.${extension}`; }
  private getReportImageFile(item: EvidenceItem) { return item.reportFile; }
  private getDocxImageType(mimeType: string): 'jpg' | 'png' | 'gif' | 'bmp' { if (mimeType.includes('png')) return 'png'; if (mimeType.includes('gif')) return 'gif'; if (mimeType.includes('bmp')) return 'bmp'; return 'jpg'; }
  private mapMimeTypeToPdfFormat(mimeType: string): 'JPEG' | 'PNG' | 'WEBP' { if (mimeType.includes('png')) return 'PNG'; if (mimeType.includes('webp')) return 'WEBP'; return 'JPEG'; }
  private async fileToDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
  private downloadBlob(blob: Blob, fileName: string) { const downloadUrl = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(downloadUrl); }
  private buildReportFileName(extension: 'docx' | 'pdf') { const now = new Date(); const dateStamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'); return `reporte-evidencias-${dateStamp}.${extension}`; }
  private formatCapturedDate(value: string) { if (!value) return this.formatDateForBadge(this.getTodayDateInputValue()); return this.formatDateForBadge(value); }
  private formatDateForBadge(value: string) { const [year, month, day] = value.split('-'); if (!year || !month || !day) return value; return `${day}/${month}/${year}`; }
  private getTodayDateInputValue() { const now = new Date(); return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'); }
  private chunkItems<T>(items: T[], size: number) { const chunks: T[][] = []; for (let index = 0; index < items.length; index += size) { chunks.push(items.slice(index, index + size)); } return chunks; }
}