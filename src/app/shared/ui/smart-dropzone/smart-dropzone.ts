import { Component, HostListener, signal, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-smart-dropzone',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './smart-dropzone.html',
  styleUrls: ['./smart-dropzone.scss']
})
export class SmartDropzoneComponent {
  
  isDragging = signal<boolean>(false);
  filesDropped = output<File[]>();

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.filesDropped.emit(Array.from(files));
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.filesDropped.emit(Array.from(input.files));
    }
  }

  // 👇 NUEVO: El Motor de Captura B2B (Ctrl + V) 👇
  @HostListener('window:paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    
    // Iteramos sobre la memoria del portapapeles buscando imágenes (las capturas)
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          // Nombramos el archivo temporalmente para mantener un registro limpio
          const newFile = new File([file], `captura-cpicsa-${Date.now()}.png`, { type: file.type });
          pastedFiles.push(newFile);
        }
      }
    }

    // Si encontró la captura, la escupe hacia el componente padre
    if (pastedFiles.length > 0) {
      this.filesDropped.emit(pastedFiles);
    }
  }
}