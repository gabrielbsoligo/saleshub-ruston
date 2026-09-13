import { useState } from 'react';
import { Check, ExternalLink, KeyRound, Pencil, RotateCcw, Save, X } from 'lucide-react';
import type { ChaveBuscaId, Lead, SiteAudit } from '../types';
import { CHAVE_INFO, apagarChave, chaveAtual, chavesPendentes, definirChave, validarChave } from '../lib/chavesBusca';

// Bloco "Chaves de busca": o que a PRÓXIMA execução vai usar como identificador
// (marca, site, redes da empresa, ficha do Google, termo da Meta), com origem e
// validação humana. Fica no topo do lead expandido no funil — valida antes de dar
// play, pra não auditar coisa errada. Toda a lógica está em lib/chavesBusca.ts.
export function ChavesBusca({
  lead,
  audit,
  chaves,
  onSave,
}: {
  lead: Lead;
  audit: SiteAudit | null;
  chaves: ChaveBuscaId[];
  onSave: (next: Lead) => Promise<void>;
}) {
  const [editando, setEditando] = useState<ChaveBuscaId | null>(null);
  const [valor, setValor] = useState('');
  const [salvando, setSalvando] = useState(false);
  if (!chaves.length) return null;
  const pendentes = chavesPendentes(lead, audit, chaves);

  const salvar = async (next: Lead) => {
    setSalvando(true);
    try {
      await onSave(next);
      setEditando(null);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="mb-4 rounded-2xl border border-v4-border-strong bg-v4-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-v4-text">
          <KeyRound size={15} className="text-v4-red" /> Chaves de busca desta fase
          <span className="text-xs font-normal text-v4-text-muted">— confira antes de rodar: a auditoria usa exatamente isto</span>
        </p>
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${pendentes ? 'bg-[rgba(250,204,21,0.15)] text-v4-warning' : 'bg-[rgba(34,197,94,0.15)] text-v4-success'}`}>
          {pendentes ? `${pendentes} sem validação` : 'todas validadas'}
        </span>
      </div>
      <div className="divide-y divide-v4-border">
        {chaves.map((id) => {
          const c = chaveAtual(lead, audit, id);
          const info = CHAVE_INFO[id];
          const emEdicao = editando === id;
          return (
            <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-sm">
              <div className="w-44 shrink-0" title={info.ajuda}>
                <p className="font-medium text-v4-text">{info.label}</p>
                <p className="text-[11px] text-v4-text-disabled">{c.origem}</p>
              </div>
              <div className="min-w-0 flex-1">
                {emEdicao ? (
                  <input
                    autoFocus
                    value={valor}
                    onChange={(e) => setValor(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void salvar(definirChave(lead, id, valor));
                      if (e.key === 'Escape') setEditando(null);
                    }}
                    placeholder={id === 'gmn' ? 'Nome exato pra buscar no Google (ex.: "Du Vale Descartáveis")' : id === 'site' ? 'https://…' : id === 'instagram' || id === 'facebook' ? '@handle ou URL' : 'texto'}
                    className="w-full rounded-lg border border-v4-red bg-v4-surface px-3 py-1.5 text-sm text-v4-text outline-none"
                  />
                ) : c.valor ? (
                  c.link ? (
                    <a href={c.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate font-medium text-v4-text hover:text-v4-red">
                      {c.valor} <ExternalLink size={12} className="shrink-0 text-v4-text-muted" />
                    </a>
                  ) : (
                    <span className="font-medium text-v4-text">{c.valor}</span>
                  )
                ) : (
                  <span className="text-v4-text-disabled">
                    — não encontrado{c.rejeitados.length ? ` · ${c.rejeitados.length} descartado(s)` : ''}
                    {id === 'gmn' && c.consulta ? ` · vai buscar por "${c.consulta}"` : ''}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {emEdicao ? (
                  <>
                    <button
                      onClick={() => void salvar(definirChave(lead, id, valor))}
                      disabled={salvando || !valor.trim()}
                      className="flex items-center gap-1 rounded-md border border-v4-success px-2 py-0.5 text-[11px] font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)] disabled:opacity-50"
                    >
                      <Save size={11} /> Salvar
                    </button>
                    <button onClick={() => setEditando(null)} className="rounded-md border border-v4-border px-2 py-0.5 text-[11px] text-v4-text-muted hover:text-v4-text">
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    {c.validado ? (
                      <span className="rounded-full bg-[rgba(34,197,94,0.15)] px-2 py-0.5 text-[11px] font-medium text-v4-success">validado</span>
                    ) : c.valor ? (
                      <button
                        onClick={() => void salvar(validarChave(lead, id))}
                        title="Está certo — manter (a re-busca não sobrescreve)"
                        className="flex items-center gap-1 rounded-md border border-v4-success px-2 py-0.5 text-[11px] font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)]"
                      >
                        <Check size={11} /> Manter
                      </button>
                    ) : null}
                    <button
                      onClick={() => {
                        setEditando(id);
                        setValor(id === 'gmn' ? c.consulta ?? '' : c.padrao ? '' : c.link ?? c.valor ?? '');
                      }}
                      title={id === 'gmn' ? 'Informar o nome exato pra buscar a ficha certa' : 'Corrigir manualmente (vira validado)'}
                      className="flex items-center gap-1 rounded-md border border-v4-border px-2 py-0.5 text-[11px] font-medium text-v4-text-muted transition hover:border-v4-red hover:text-v4-red"
                    >
                      <Pencil size={11} /> {id === 'gmn' ? 'Buscar por…' : 'Corrigir'}
                    </button>
                    {c.valor && (
                      <button
                        onClick={() => void salvar(apagarChave(lead, id))}
                        title={c.padrao ? 'Já é o padrão' : id === 'marca' || id === 'meta_termo' ? 'Voltar ao padrão derivado' : 'Não é isso — apagar (nunca mais volta na busca)'}
                        disabled={c.padrao}
                        className="flex items-center gap-1 rounded-md border border-v4-border px-2 py-0.5 text-[11px] font-medium text-v4-text-muted transition hover:border-v4-error hover:text-v4-error disabled:opacity-40"
                      >
                        {id === 'marca' || id === 'meta_termo' ? <><RotateCcw size={11} /> Padrão</> : <><X size={11} /> Apagar</>}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
