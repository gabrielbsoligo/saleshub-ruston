import { useState, type InputHTMLAttributes } from 'react';
import toast from 'react-hot-toast';
import { X, UploadCloud, UserPlus, FileSpreadsheet, Loader2 } from 'lucide-react';
import type { Projeto, WfLead } from '../lib/projectsStore';
import { parseSpreadsheet, type RawLeadRow } from '../lib/parseSpreadsheet';
import { entrarLeads, resumoEntrada, type ResultadoEntrada } from '../lib/adicionarLeads';
import { isValidCnpj, normalizeCnpjDigits } from '../lib/validation';
import { registrarErro } from '../lib/errorLog';

type Modo = 'lista' | 'manual';

/**
 * Adiciona leads a um projeto JÁ ABERTO, de dois jeitos:
 *  - Planilha: mais um CSV/XLSX pelo mesmo pipeline da importação inicial;
 *  - Manual: um lead por vez, só com o que a Triagem (F1) precisa.
 * Nos dois casos o lead cai na etapa 0 (F1) e é deduplicado contra o projeto
 * (CNPJ e telefone). Quem persiste no projeto é o Workflow (onAdicionados).
 */
export function AdicionarLeadsModal({
  projeto,
  leadsAtuais,
  modoInicial = 'lista',
  onClose,
  onAdicionados,
}: {
  projeto: Projeto;
  leadsAtuais: WfLead[];
  modoInicial?: Modo;
  onClose: () => void;
  /** Persiste o vínculo no projeto e devolve o que de fato entrou; o modal só confirma sucesso quando resolve. */
  onAdicionados: (novos: WfLead[]) => Promise<{ vinculados: WfLead[]; removidos: number }>;
}) {
  const [modo, setModo] = useState<Modo>(modoInicial);
  const [ocupado, setOcupado] = useState(false);
  const [prog, setProg] = useState({ done: 0, total: 0 });
  const [drag, setDrag] = useState(false);
  const [form, setForm] = useState({ cnpj: '', companyName: '', phone: '', email: '', site: '', revenueBand: '' });

  // Todo o caminho (ler arquivo → parse → Triagem → gravar → vincular ao projeto) fica
  // dentro de um único try/finally, com a guarda de reentrada ligada desde o início.
  const processar = async (obterLinhas: () => Promise<RawLeadRow[] | null>, origem: string) => {
    if (ocupado) return;
    setOcupado(true);
    setProg({ done: 0, total: 0 });
    try {
      const rows = await obterLinhas();
      if (!rows) return;
      setProg({ done: 0, total: rows.length });
      let r: ResultadoEntrada = await entrarLeads(projeto, rows, leadsAtuais, 'adicao', setProg);
      if (r.novos.length) {
        // só é sucesso depois que o projeto gravou — e com o que de fato ficou vinculado
        // (outra aba pode ter adicionado o mesmo CNPJ/telefone no meio do caminho)
        const fim = await onAdicionados(r.novos);
        r = { ...r, novos: fim.vinculados, removidosNaGravacao: fim.removidos };
      }
      if (r.novos.length) {
        toast.success(resumoEntrada(r), { duration: 8000 });
        onClose();
      } else {
        toast.error(`Nenhum lead novo: ${resumoEntrada(r)}`, { duration: 8000 });
      }
    } catch (e) {
      const err = e as { message?: string; details?: string; code?: string };
      const msg = err?.message ? `${err.message}${err.details ? ` — ${err.details}` : ''}${err.code ? ` (${err.code})` : ''}` : e instanceof Error ? e.message : JSON.stringify(e);
      toast.error(`Falha ao adicionar: ${msg}`, { duration: 12000 });
      void registrarErro({ etapa: 'Adicionar leads ao projeto', empresa: projeto.nome, mensagem: msg, detalhe: { origem, erro: e } });
    } finally {
      setOcupado(false);
    }
  };

  const importarArquivo = (file: File) =>
    processar(async () => {
      if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
        toast.error('Formato não suportado. Use CSV ou XLSX.');
        return null;
      }
      const res = parseSpreadsheet(await file.arrayBuffer());
      if (res.missingColumns.length) {
        toast.error(`Colunas obrigatórias ausentes: ${res.missingColumns.join(', ')}`);
        return null;
      }
      if (!res.rows.length) {
        toast.error('Nenhuma linha encontrada na planilha.');
        return null;
      }
      return res.rows;
    }, file.name);

  const cnpjOk = isValidCnpj(normalizeCnpjDigits(form.cnpj));
  const salvarManual = async () => {
    if (!cnpjOk) {
      toast.error('CNPJ inválido (dígito verificador).');
      return;
    }
    await processar(async () => [{ ...form }], 'manual');
  };

  const campo = (k: keyof typeof form, label: string, placeholder: string, extra?: Partial<InputHTMLAttributes<HTMLInputElement>>) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-v4-text-muted">{label}</span>
      <input
        value={form[k]}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        onKeyDown={(e) => e.key === 'Enter' && !ocupado && void salvarManual()}
        placeholder={placeholder}
        disabled={ocupado}
        className="w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none transition focus:border-v4-red disabled:opacity-50"
        {...extra}
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={ocupado ? undefined : onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-v4-border bg-v4-card p-6 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold text-v4-text">
            <UserPlus size={20} className="text-v4-red" /> Adicionar leads
            <span className="truncate text-sm font-normal text-v4-text-muted">· {projeto.nome}</span>
          </h2>
          <button onClick={onClose} disabled={ocupado} className="text-v4-text-muted hover:text-v4-red disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-v4-surface p-1">
          {([
            ['lista', FileSpreadsheet, 'Nova lista (CSV/XLSX)'],
            ['manual', UserPlus, 'Manual'],
          ] as const).map(([m, Icon, label]) => (
            <button
              key={m}
              onClick={() => setModo(m)}
              disabled={ocupado}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                modo === m ? 'bg-v4-card text-v4-text shadow' : 'text-v4-text-muted hover:text-v4-text'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {ocupado ? (
          <div className="rounded-xl border border-v4-border bg-v4-surface p-6 text-center">
            <p className="mb-1 flex items-center justify-center gap-2 text-sm font-medium text-v4-text">
              <Loader2 size={16} className="animate-spin text-v4-red" /> Validando na Receita (Triagem)…
            </p>
            <p className="mb-3 text-xs text-v4-text-muted">{prog.done} de {prog.total}</p>
            <div className="mx-auto h-2 w-full max-w-sm overflow-hidden rounded-full bg-v4-card">
              <div className="h-full bg-v4-red transition-all" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} />
            </div>
          </div>
        ) : modo === 'lista' ? (
          <>
            <p className="mb-3 text-xs text-v4-text-muted">
              Mesmo pipeline da importação: validação na Receita e entrada na <b>Triagem (F1)</b>. CNPJ ou telefone que já estão
              neste projeto são ignorados; CNPJ já enriquecido em outro projeto entra mantendo o enriquecimento.
            </p>
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void importarArquivo(f); }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 text-center transition ${
                drag ? 'border-v4-red bg-[rgba(230,57,70,0.08)]' : 'border-v4-border hover:border-v4-red'
              }`}
            >
              <UploadCloud size={36} className={drag ? 'text-v4-red' : 'text-v4-text-muted'} />
              <p className="text-sm font-medium text-v4-text">Arraste a lista aqui ou clique para selecionar</p>
              <p className="text-xs text-v4-text-disabled">.csv ou .xlsx — coluna CNPJ obrigatória</p>
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importarArquivo(f); }} />
            </label>
          </>
        ) : (
          <>
            <p className="mb-3 text-xs text-v4-text-muted">
              Só o <b>CNPJ</b> é obrigatório: a Triagem (F1) busca razão social, situação e ramo na Receita. Os demais campos
              ajudam o F2 (contato) e o F3 (site).
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">{campo('cnpj', 'CNPJ *', '00.000.000/0001-00', { autoFocus: true, inputMode: 'numeric' })}</div>
              <div className="sm:col-span-2">{campo('companyName', 'Empresa (opcional)', 'Nome fantasia ou razão social')}</div>
              {campo('phone', 'Telefone / WhatsApp', '(11) 99999-9999', { inputMode: 'tel' })}
              {campo('email', 'E-mail', 'contato@empresa.com.br', { inputMode: 'email' })}
              {campo('site', 'Site', 'https://empresa.com.br', { inputMode: 'url' })}
              {campo('revenueBand', 'Faixa de faturamento', 'Ex.: 1-5 mi')}
            </div>
            {form.cnpj && !cnpjOk && <p className="mt-2 text-xs text-v4-error">CNPJ inválido (dígito verificador).</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg border border-v4-border px-4 py-2 text-sm text-v4-text-muted transition hover:text-v4-text">
                Cancelar
              </button>
              <button
                onClick={() => void salvarManual()}
                disabled={!cnpjOk}
                className="rounded-lg bg-v4-red px-4 py-2 text-sm font-semibold text-white transition hover:bg-v4-red-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Adicionar na Triagem (F1)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
