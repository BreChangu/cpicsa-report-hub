import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SmartDropzone } from './smart-dropzone';

describe('SmartDropzone', () => {
  let component: SmartDropzone;
  let fixture: ComponentFixture<SmartDropzone>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SmartDropzone],
    }).compileComponents();

    fixture = TestBed.createComponent(SmartDropzone);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
