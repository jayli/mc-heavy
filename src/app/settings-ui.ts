import type { LightQuality } from '../render/light-quality';

export type SettingsState = Readonly<{
  quality: LightQuality;
  rainEnabled: boolean;
  tntDestroyEnabled: boolean;
}>;

export type SettingsHooks = Readonly<{
  getState(): SettingsState;
  setQuality(quality: LightQuality): void;
  toggleRain(): void;
  toggleTntDestroy(): void;
  onOpen?(): void;
  onClose?(): void;
}>;

export class SettingsUi {
  readonly element: HTMLElement;
  private readonly ownerDocument: Document;
  private readonly modal: HTMLElement;
  private readonly qualityButtons = new Map<LightQuality, HTMLButtonElement>();
  private readonly rainButton: HTMLButtonElement;
  private readonly tntButton: HTMLButtonElement;

  constructor(ownerDocument: Document, private readonly hooks: SettingsHooks) {
    this.ownerDocument = ownerDocument;
    this.element = ownerDocument.createElement('button');
    this.element.dataset.testid = 'settings-button';
    this.element.textContent = '⚙';
    this.element.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:4',
      'width:40px',
      'height:40px',
      'border:1px solid rgba(255,255,255,.4)',
      'border-radius:6px',
      'background:rgba(8,12,18,.75)',
      'color:#fff',
      'font:18px system-ui',
      'cursor:pointer',
    ].join(';');
    this.element.addEventListener('click', () => this.show());

    this.modal = ownerDocument.createElement('div');
    this.modal.dataset.testid = 'settings-modal';
    this.modal.style.cssText = [
      'display:none',
      'position:fixed',
      'inset:0',
      'z-index:5',
      'align-items:center',
      'justify-content:center',
      'background:rgba(8,12,18,.6)',
    ].join(';');
    const panel = ownerDocument.createElement('div');
    panel.style.cssText = [
      'min-width:320px',
      'padding:18px',
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:10px',
      'background:rgba(12,18,28,.95)',
      'color:#f4f7fb',
      'font:14px system-ui',
    ].join(';');

    panel.append(this.section('画质 / 光照'));
    const qualityRow = ownerDocument.createElement('div');
    qualityRow.style.cssText = 'display:flex;gap:8px;margin:10px 0 18px;';
    for (const [quality, label] of [
      ['low', '性能'],
      ['medium', '平衡'],
      ['high', '画质'],
    ] as const) {
      const button = ownerDocument.createElement('button');
      button.dataset.testid = `quality-${quality}`;
      button.textContent = label;
      button.style.cssText = this.buttonStyle();
      button.addEventListener('click', () => this.hooks.setQuality(quality));
      this.qualityButtons.set(quality, button);
      qualityRow.append(button);
    }
    panel.append(qualityRow);

    this.rainButton = ownerDocument.createElement('button');
    this.rainButton.dataset.testid = 'rain-toggle';
    this.rainButton.style.cssText = this.buttonStyle();
    this.rainButton.addEventListener('click', () => this.hooks.toggleRain());
    panel.append(this.rainButton);

    this.tntButton = ownerDocument.createElement('button');
    this.tntButton.dataset.testid = 'tnt-destroy-toggle';
    this.tntButton.style.cssText = this.buttonStyle();
    this.tntButton.addEventListener('click', () => this.hooks.toggleTntDestroy());
    panel.append(this.tntButton);

    const close = ownerDocument.createElement('button');
    close.dataset.testid = 'settings-close';
    close.textContent = '关闭';
    close.style.cssText = this.buttonStyle();
    close.addEventListener('click', () => this.hide());
    panel.append(close);

    this.modal.append(panel);
  }

  attach(container: HTMLElement): void {
    container.append(this.element, this.modal);
    this.refresh();
  }

  show(): void {
    this.refresh();
    this.modal.style.display = 'flex';
    this.hooks.onOpen?.();
  }

  hide(): void {
    this.modal.style.display = 'none';
    this.hooks.onClose?.();
  }

  refresh(): void {
    const state = this.hooks.getState();
    for (const [quality, button] of this.qualityButtons) {
      button.setAttribute('aria-pressed', String(quality === state.quality));
    }
    this.rainButton.textContent = state.rainEnabled ? '停止下雨' : '开始下雨';
    this.rainButton.setAttribute('aria-pressed', String(state.rainEnabled));
    this.tntButton.textContent = state.tntDestroyEnabled ? 'TNT 破坏：开' : 'TNT 破坏：关';
    this.tntButton.setAttribute('aria-pressed', String(state.tntDestroyEnabled));
  }

  private section(title: string): HTMLElement {
    const heading = this.ownerDocument.createElement('h2');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 6px;font-size:14px;color:#9fb3d1;';
    return heading;
  }

  private buttonStyle(): string {
    return [
      'margin-top:8px',
      'padding:8px 12px',
      'border:1px solid rgba(255,255,255,.3)',
      'border-radius:6px',
      'background:rgba(255,255,255,.06)',
      'color:#fff',
      'font:13px system-ui',
      'cursor:pointer',
    ].join(';');
  }
}
