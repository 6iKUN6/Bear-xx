import type { LlmModelPreset } from './llm.types';

export const BUILTIN_LLM_MODEL_PRESETS: LlmModelPreset[] = [
  {
    id: 'openai:gpt-4.1',
    provider: 'openai',
    platform: 'openai',
    model: 'gpt-4.1',
  },
  {
    id: 'openai:gpt-5.5',
    provider: 'openai',
    platform: 'openai',
    model: 'gpt-5.5',
  },
];
