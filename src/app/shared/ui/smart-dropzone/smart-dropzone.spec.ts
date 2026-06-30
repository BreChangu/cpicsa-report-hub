import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SmartDropzoneComponent } from './smart-dropzone';

describe('SmartDropzone', () => {
  let component: SmartDropzoneComponent;
  let fixture: ComponentFixture<SmartDropzoneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SmartDropzoneComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SmartDropzoneComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
