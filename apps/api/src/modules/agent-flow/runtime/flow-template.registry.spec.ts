import { createFlowDefinitionPreset } from '../definition/flow-definition.templates';
import { FlowTemplateRegistry } from './flow-template.registry';

describe('FlowTemplateRegistry', () => {
  it('为全部内置预设返回彼此独立的标准 FlowDefinition', () => {
    const registry = new FlowTemplateRegistry();

    const presets = registry.list();
    const direct = registry.get('direct');
    const directAgain = registry.get('direct');

    expect(presets).toEqual([
      'blank',
      'direct',
      'react',
      'plan_execute',
      'hybrid',
    ]);
    expect(direct).not.toBe(directAgain);
    expect(registry.get('direct')).toEqual(
      createFlowDefinitionPreset('direct'),
    );
    expect(registry.get('react')).toEqual(createFlowDefinitionPreset('react'));
    expect(registry.get('plan_execute')).toEqual(
      createFlowDefinitionPreset('plan_execute'),
    );
    expect(registry.get('hybrid')).toEqual(
      createFlowDefinitionPreset('hybrid'),
    );
  });
});
