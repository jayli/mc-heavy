import {
  importFromLegacyIndexedDb,
  parseLegacySnapshot,
  type LegacyImportReport,
  type ParsedLegacySnapshot,
} from '../persistence/legacy-import';

export type ImportChoice =
  | Readonly<{ kind: 'new' }>
  | Readonly<{ kind: 'import'; snapshot: ParsedLegacySnapshot }>;

export class ImportUi {
  readonly element: HTMLElement;
  private readonly modal: HTMLElement;
  private readonly ownerDocument: Document;
  private readonly error: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private resolveChoice: ((choice: ImportChoice) => void) | null = null;

  constructor(ownerDocument: Document, private readonly indexedDb: IDBFactory) {
    this.ownerDocument = ownerDocument;
    this.modal = ownerDocument.createElement('div');
    this.modal.dataset.testid = 'import-modal';
    this.modal.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:6',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(8,12,18,.72)',
    ].join(';');

    const panel = ownerDocument.createElement('div');
    panel.style.cssText = [
      'min-width:340px',
      'padding:20px',
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:10px',
      'background:rgba(12,18,28,.97)',
      'color:#f4f7fb',
      'font:14px system-ui',
      'text-align:center',
    ].join(';');

    const title = ownerDocument.createElement('h1');
    title.textContent = 'mc-heavy';
    title.style.cssText = 'margin:0 0 14px;font-size:20px;';
    panel.append(title);

    const buttons: Array<Readonly<{ id: string; label: string; run(): void | Promise<void> }>> = [
      { id: 'import-new', label: '开启新世界', run: () => this.choose({ kind: 'new' }) },
      { id: 'import-indexeddb', label: '从 IndexedDB 导入', run: () => this.importIndexedDb() },
      { id: 'import-file', label: '从 JSON 文件导入', run: () => this.fileInput.click() },
    ];
    for (const button of buttons) {
      const element = ownerDocument.createElement('button');
      element.dataset.testid = button.id;
      element.textContent = button.label;
      element.style.cssText = [
        'display:block',
        'width:100%',
        'margin-top:10px',
        'padding:10px 14px',
        'border:1px solid rgba(255,255,255,.3)',
        'border-radius:6px',
        'background:rgba(255,255,255,.06)',
        'color:#fff',
        'font:14px system-ui',
        'cursor:pointer',
      ].join(';');
      element.addEventListener('click', () => void button.run());
      panel.append(element);
    }

    this.error = ownerDocument.createElement('div');
    this.error.dataset.testid = 'import-error';
    this.error.style.cssText = 'margin-top:12px;color:#ff9b9b;min-height:18px;';
    panel.append(this.error);

    this.fileInput = ownerDocument.createElement('input');
    this.fileInput.dataset.testid = 'import-file-input';
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => void this.importFile());
    panel.append(this.fileInput);

    this.modal.append(panel);
    this.element = this.modal;
  }

  request(): Promise<ImportChoice> {
    return new Promise((resolve) => {
      this.resolveChoice = resolve;
    });
  }

  showReport(report: LegacyImportReport): void {
    const toast = this.ownerDocument.createElement('div');
    toast.dataset.testid = 'import-report';
    toast.textContent = `导入 ${report.importedBlocks} 方块，封存 ${report.preservedEntries} 条，警告 ${report.warnings.length} 条`;
    toast.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:14px',
      'transform:translateX(-50%)',
      'z-index:4',
      'padding:8px 14px',
      'border:1px solid rgba(168,230,161,.5)',
      'border-radius:6px',
      'background:rgba(12,18,28,.9)',
      'color:#a8e6a1',
      'font:13px system-ui',
    ].join(';');
    this.ownerDocument.body.append(toast);
  }

  hide(): void {
    this.modal.style.display = 'none';
  }

  private choose(choice: ImportChoice): void {
    const resolve = this.resolveChoice;
    if (!resolve) return;
    this.resolveChoice = null;
    this.modal.style.display = 'none';
    resolve(choice);
  }

  private async importIndexedDb(): Promise<void> {
    try {
      const snapshot = await importFromLegacyIndexedDb(this.indexedDb);
      if (!snapshot) {
        this.error.textContent = '没有发现 mc-lite 存档（需与旧游戏同源）';
        return;
      }
      this.choose({ kind: 'import', snapshot });
    } catch (error) {
      this.error.textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async importFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    try {
      const snapshot = parseLegacySnapshot(JSON.parse(await file.text()));
      this.choose({ kind: 'import', snapshot });
    } catch (error) {
      this.error.textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
