import type { LlmModelPreset } from './llm.types';

export const BUILTIN_LLM_MODEL_PRESETS: LlmModelPreset[] = [
  {
    id: 'openai:gpt-4o-mini',
    provider: 'openai',
    platform: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    id: 'openai:gpt-4.1-mini',
    provider: 'openai',
    platform: 'openai',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'openai:gpt-4.1',
    provider: 'openai',
    platform: 'openai',
    model: 'gpt-4.1',
  },
];
