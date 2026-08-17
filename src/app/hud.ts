import type { FrameMetricsSummary } from '../benchmark/frame-metrics';

export type HudDiagnostics = Readonly<{
  backend: 'webgpu' | 'webgl2';
  metrics: FrameMetricsSummary;
  renderPages: number;
  visibleSections: number;
  workerQueue: number;
  uploadBytes: number;
}>;

const rows = [
  ['backend', 'Backend'],
  ['average-fps', 'Average FPS'],
  ['one-percent-low', '1% low'],
  ['p99-frame-ms', 'p99 frame'],
  ['render-pages', 'Render pages'],
  ['visible-sections', 'Visible sections'],
  ['worker-queue', 'Worker queue'],
  ['upload-bytes', 'Upload bytes'],
] as const;

export class GameHud {
  readonly element: HTMLElement;
  private readonly values = new Map<(typeof rows)[number][0], HTMLElement>();

  constructor(ownerDocument: Document) {
    const element = ownerDocument.createElement('aside');
    element.setAttribute('aria-label', 'Performance HUD');
    element.style.cssText = [
      'position:fixed',
      'top:12px',
      'left:12px',
      'z-index:2',
      'min-width:190px',
      'padding:10px 12px',
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:6px',
      'background:rgba(8,12,18,.78)',
      'color:#f4f7fb',
      'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none',
    ].join(';');
    for (const [testId, label] of rows) {
      const row = ownerDocument.createElement('div');
      row.dataset.testid = testId;
      row.textContent = `${label}: —`;
      this.values.set(testId, row);
      element.append(row);
    }
    this.element = element;
  }

  update(diagnostics: HudDiagnostics): void {
    this.set('backend', `Backend: ${diagnostics.backend}`);
    this.set('average-fps', `Average FPS: ${diagnostics.metrics.averageFps.toFixed(1)}`);
    this.set('one-percent-low', `1% low: ${diagnostics.metrics.onePercentLowFps.toFixed(1)} FPS`);
    this.set('p99-frame-ms', `p99 frame: ${diagnostics.metrics.p99FrameMs.toFixed(1)} ms`);
    this.set('render-pages', `Render pages: ${diagnostics.renderPages}`);
    this.set('visible-sections', `Visible sections: ${diagnostics.visibleSections}`);
    this.set('worker-queue', `Worker queue: ${diagnostics.workerQueue}`);
    this.set('upload-bytes', `Upload bytes: ${diagnostics.uploadBytes}`);
  }

  private set(key: (typeof rows)[number][0], value: string): void {
    const element = this.values.get(key);
    if (element && element.textContent !== value) element.textContent = value;
  }
}
