// =============================================================
// Gerador de Propostas — cliente mínimo das APIs Drive e Slides
// =============================================================
// REST puro com fetch (sem googleapis): o mesmo código roda no Node (CLI,
// testes) e nas Edge Functions (Deno). `fetchImpl` é injetável nos testes.
// O token chega pronto (OAuth do usuário); nunca é logado.
// =============================================================

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SLIDES = 'https://slides.googleapis.com/v1';

export const MIME = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export class ErroGoogle extends Error {
  constructor(status, corpo, onde) {
    const motivo = corpo?.error?.errors?.[0]?.reason || corpo?.error?.status || '';
    super(`${onde}: HTTP ${status}${motivo ? ` (${motivo})` : ''} ${corpo?.error?.message || ''}`.trim());
    this.status = status;
    this.motivo = motivo;
  }
}

export function criarCliente(token, fetchImpl = globalThis.fetch) {
  if (!token) throw new Error('token Google ausente (GOOGLE_ACCESS_TOKEN)');
  const auth = { Authorization: `Bearer ${token}` };

  async function json(url, init, onde) {
    const r = await fetchImpl(url, { ...init, headers: { ...auth, 'Content-Type': 'application/json', ...(init?.headers || {}) } });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErroGoogle(r.status, corpo, onde);
    return corpo;
  }

  return {
    copiar(fileId, nome, pastaId) {
      const body = { name: nome, ...(pastaId ? { parents: [pastaId] } : {}) };
      return json(`${DRIVE}/files/${fileId}/copy?supportsAllDrives=true&fields=id,name,webViewLink,exportLinks`,
        { method: 'POST', body: JSON.stringify(body) }, 'drive.files.copy');
    },

    apresentacao(id) {
      const texto = 'text(textElements(textRun(content)))';
      const fields = `pageSize,slides(objectId,pageElements(objectId,shape(${texto}),table(tableRows(tableCells(${texto})))))`;
      return json(`${SLIDES}/presentations/${id}?fields=${encodeURIComponent(fields)}`,
        { method: 'GET' }, 'slides.presentations.get');
    },

    async apagar(fileId) {
      const r = await fetchImpl(`${DRIVE}/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE', headers: auth });
      if (!r.ok) throw new ErroGoogle(r.status, await r.json().catch(() => ({})), 'drive.files.delete');
    },

    batchUpdate(id, requests) {
      return json(`${SLIDES}/presentations/${id}:batchUpdate`,
        { method: 'POST', body: JSON.stringify({ requests }) }, 'slides.batchUpdate');
    },

    // sendNotificationEmail só é aceito para user/group (anyone/domain dá 403).
    compartilhar(fileId, permissao) {
      const notif = ['user', 'group'].includes(permissao.type) ? '&sendNotificationEmail=false' : '';
      return json(`${DRIVE}/files/${fileId}/permissions?supportsAllDrives=true${notif}`,
        { method: 'POST', body: JSON.stringify(permissao) }, 'drive.permissions.create');
    },

    // files.export tem teto de 10 MB; deck com imagens passa disso.
    // Nesse caso usa o exportLinks do arquivo (mesmo token, sem o teto).
    async exportar(fileId, formato, exportLinks) {
      const mime = MIME[formato];
      if (!mime) throw new Error(`formato de exportação desconhecido: ${formato}`);
      const r = await fetchImpl(`${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(mime)}`, { headers: auth });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      const corpo = await r.json().catch(() => ({}));
      const erro = new ErroGoogle(r.status, corpo, 'drive.files.export');
      if (erro.motivo !== 'exportSizeLimitExceeded' || !exportLinks?.[mime]) throw erro;
      const r2 = await fetchImpl(exportLinks[mime], { headers: auth });
      if (!r2.ok) throw new ErroGoogle(r2.status, {}, 'exportLinks');
      return new Uint8Array(await r2.arrayBuffer());
    },
  };
}
