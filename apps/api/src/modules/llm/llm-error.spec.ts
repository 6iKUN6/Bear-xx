import { classifyLlmError } from './llm-error';

describe('classifyLlmError', () => {
  const withStatus = (status: number, message = 'boom') => {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
  };

  it('classifies 429 as retryable rate_limit', () => {
    const result = classifyLlmError(withStatus(429));
    expect(result.category).toBe('rate_limit');
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(429);
  });

  it('classifies 401/403 as non-retryable auth', () => {
    expect(classifyLlmError(withStatus(401)).category).toBe('auth');
    expect(classifyLlmError(withStatus(403)).retryable).toBe(false);
  });

  it('classifies 5xx as retryable server', () => {
    const result = classifyLlmError(withStatus(503));
    expect(result.category).toBe('server');
    expect(result.retryable).toBe(true);
  });

  it('classifies non-408 4xx as non-retryable invalid', () => {
    const result = classifyLlmError(withStatus(422));
    expect(result.category).toBe('invalid');
    expect(result.retryable).toBe(false);
  });

  it('classifies 408 as timeout', () => {
    expect(classifyLlmError(withStatus(408)).category).toBe('timeout');
  });

  it('falls back to message keywords when no status (timeout)', () => {
    const result = classifyLlmError(new Error('Request timeout after 30000ms'));
    expect(result.category).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('detects network errors from code', () => {
    const error = new Error('read ECONNRESET') as Error & { code: string };
    error.code = 'ECONNRESET';
    const result = classifyLlmError(error);
    expect(result.category).toBe('network');
    expect(result.retryable).toBe(true);
  });

  it('reads status from nested response object', () => {
    const error = new Error('bad') as Error & {
      response: { status: number };
    };
    error.response = { status: 429 };
    expect(classifyLlmError(error).category).toBe('rate_limit');
  });

  it('classifies unknown errors as non-retryable unknown', () => {
    const result = classifyLlmError(new Error('something odd'));
    expect(result.category).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('handles non-Error values', () => {
    const result = classifyLlmError('plain string');
    expect(result.category).toBe('unknown');
    expect(result.message).toBe('plain string');
  });
});
