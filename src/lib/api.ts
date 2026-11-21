const TOKEN_KEY = 'mizan_session_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore storage errors
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    auth?: boolean;
  } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (auth) {
    const token = getStoredToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const res = await fetch(path, {
    method,
    headers,
    cache: 'no-store',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  let parseFailed = false;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parseFailed = true;
      json = {};
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof json.error === 'string' ? json.error : 'تعذر تنفيذ الطلب على الخادم.',
      typeof json.code === 'string' ? json.code : undefined,
    );
  }

  if (res.status !== 204 && (parseFailed || !text)) {
    throw new ApiError(502, 'استجابة غير متوقعة من الخادم. يرجى إعادة المحاولة.', 'INVALID_RESPONSE');
  }

  return json as T;
}

export async function downloadExcelFile(path: string, fallbackName: string): Promise<void> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { headers });
  if (!res.ok) {
    let msg = 'فشل تصدير ملف Excel.';
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) msg = json.error;
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, msg);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] || fallbackName;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function streamBulkJournalPost<TProgress, TSummary>(
  payload: unknown,
  onProgress: (event: TProgress) => void,
): Promise<TSummary> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch('/api/journals/bulk-post', {
    method: 'POST',
    headers,
    cache: 'no-store',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = 'تعذر تنفيذ الترحيل الجماعي.';
    let code: string | undefined;
    try {
      const json = (await res.json()) as { error?: string; code?: string };
      if (json.error) message = json.error;
      if (json.code) code = json.code;
    } catch {
      // ignore json parse failure
    }
    throw new ApiError(res.status, message, code);
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.includes('application/x-ndjson') || !res.body) {
    const json = (await res.json()) as { summary: TSummary };
    return json.summary;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalSummary: TSummary | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        const parsed = JSON.parse(line) as
          | ({ type: 'progress' } & TProgress)
          | { type: 'done'; summary: TSummary };
        if (parsed.type === 'progress') {
          onProgress(parsed);
        } else if (parsed.type === 'done') {
          finalSummary = parsed.summary;
        }
      }
      newlineIdx = buffer.indexOf('\n');
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const parsed = JSON.parse(tail) as
      | ({ type: 'progress' } & TProgress)
      | { type: 'done'; summary: TSummary };
    if (parsed.type === 'done') {
      finalSummary = parsed.summary;
    }
  }

  if (!finalSummary) {
    throw new ApiError(502, 'لم يكتمل تقرير الترحيل الجماعي من الخادم.', 'INCOMPLETE_STREAM');
  }

  return finalSummary;
}

