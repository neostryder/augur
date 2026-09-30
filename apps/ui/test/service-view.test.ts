import { describe, expect, it } from 'vitest';
import { CLASSIFIER_TEXT, MODE_TEXT, classifierChooser, modeChooser, renderService, type ConfigLine, type ServiceModel } from '../src/views/service';

const line = (over: Partial<ConfigLine>): ConfigLine => ({ key: 'maxConcurrent', label: 'Jobs at once', help: 'How many jobs run together.', kind: 'number', min: 1, max: 64, weakens: false, value: '8', default: '8', ...over });
const model = (over: Partial<ServiceModel> = {}): ServiceModel => ({ lines: [], service: { running: true, pid: 99 }, runJobs: true, note: '', error: '', busy: false, unavailable: '', ...over });

describe('the service page', () => {
  it('shows only the mode choice while Augur is set to usage only', () => {
    const html = renderService(model({ runJobs: false, lines: [line({})] }));
    expect(html).toContain(MODE_TEXT.usage);
    expect(html).not.toContain('data-cfg=');
    expect(html).not.toContain('service-restart');
  });

  it('lists the settings when jobs are on, and marks a changed value', () => {
    const html = renderService(model({ lines: [line({ value: '3' })] }));
    expect(html).toContain('data-cfg="maxConcurrent"');
    expect(html).toContain('(changed)');
    expect(html).toContain('service-restart');
  });

  it('locks a setting that lowers the service checks and tells the reader how to change it', () => {
    const html = renderService(model({ lines: [line({ key: 'requirePick', label: 'Require a pick', kind: 'bool', weakens: true, value: 'true', default: 'true' })] }));
    expect(html).toMatch(/data-cfg="requirePick"[^>]*disabled/);
    expect(html).toContain('augur config set');
  });

  it('locks the adapter list once it carries the exec adapter, so the page cannot drop it silently', () => {
    const adapters = line({ key: 'adapters', label: 'Adapters', kind: 'list', choices: ['codex-exec', 'exec'], value: 'codex-exec,exec', default: 'codex-exec' });
    const withExec = renderService(model({ lines: [adapters] }));
    expect(withExec).toMatch(/data-cfg-item="adapters" value="exec" checked\s+disabled/);
    const without = renderService(model({ lines: [{ ...adapters, value: 'codex-exec' }] }));
    expect(without).not.toContain('value="exec"');
  });

  it('says where task text goes for the classifier that is chosen', () => {
    const jev = renderService(model({ lines: [line({ key: 'decision.backend', label: 'Task classifier', kind: 'choice', choices: ['none', 'laya', 'jev'], value: 'jev', default: 'none' })] }));
    expect(jev).toContain('hosted service from TypeSafe');
    expect(CLASSIFIER_TEXT.laya).toContain('your own computers');
  });

  it('marks the current mode as checked', () => {
    expect(modeChooser(true)).toMatch(/aria-checked="true" class="on" data-action="dispatch-mode" data-value="jobs"/);
    expect(modeChooser(false)).toMatch(/aria-checked="true" class="on" data-action="dispatch-mode" data-value="usage"/);
  });
});

describe('the classifier choice in first-run setup', () => {
  it('marks the current choice and says where task text goes for it', () => {
    const html = classifierChooser('jev');
    expect(html).toMatch(/aria-checked="true" class="on" data-action="dispatch-classifier" data-value="jev"/);
    expect(html).toContain('hosted service from TypeSafe');
    expect(classifierChooser('none')).toContain('Nothing classifies tasks');
    expect(classifierChooser('laya')).toContain('stays on your network');
  });
});
