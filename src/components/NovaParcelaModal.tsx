// =============================================================
// NovaParcelaModal — Adiciona parcela a um recebimento existente
// =============================================================
// Escolhe um recebimento de origem, informa nova data e valor,
// e cria um novo recebimento com numero_parcela = max+1 +
// comissoes replicadas dos colaboradores da parcela anterior
// (proporcionais ao novo valor).
// =============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';

interface RecebimentoLite {
  id: string;
  deal_id: string | null;
  tipo: string;
  numero_parcela: number;
  data_prevista: string;
  valor_contrato: number;
  empresa: string | null;
  status: string;
}

interface ComissaoTemplate {
  member_id: string | null;
  member_name: string;
  role_comissao: string;
  percentual: number;
  categoria: string;
  tipo: string;
  observacao: string | null;
  editado_manualmente: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function fmt(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export const NovaParcelaModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const [recebimentos, setRecebimentos] = useState<RecebimentoLite[]>([]);
  const [buscaEmpresa, setBuscaEmpresa] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [novaParcelaNum, setNovaParcelaNum] = useState<number>(2);
  const [dataPrevista, setDataPrevista] = useState('');
  const [valorContrato, setValorContrato] = useState('');
  const [observacao, setObservacao] = useState('');
  const [comissoesTemplate, setComissoesTemplate] = useState<ComissaoTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fetch recebimentos existentes ao abrir
  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setDataPrevista('');
    setValorContrato('');
    setObservacao('');
    setComissoesTemplate([]);
    setBuscaEmpresa('');
    (async () => {
      setLoading(true);
      // Pega todos os recebimentos + empresa do deal (se existir)
      const { data } = await supabase
        .from('deal_recebimentos')
        .select('id, deal_id, tipo, numero_parcela, data_prevista, valor_contrato, empresa, status, deals(empresa)')
        .order('created_at', { ascending: false })
        .limit(500);
      const mapped: RecebimentoLite[] = (data || []).map((r: any) => ({
        id: r.id,
        deal_id: r.deal_id,
        tipo: r.tipo,
        numero_parcela: r.numero_parcela,
        data_prevista: r.data_prevista,
        valor_contrato: Number(r.valor_contrato),
        empresa: r.empresa || r.deals?.empresa || null,
        status: r.status,
      }));
      setRecebimentos(mapped);
      setLoading(false);
    })();
  }, [open]);

  // Quando escolhe recebimento, carrega comissoes dele pra replicar
  useEffect(() => {
    if (!selectedId) {
      setComissoesTemplate([]);
      return;
    }
    (async () => {
      const sel = recebimentos.find(r => r.id === selectedId);
      if (!sel) return;

      // Pre-preenche formulário
      setDataPrevista(addDays(sel.data_prevista, 30));
      setValorContrato(String(sel.valor_contrato));

      // Proximo numero_parcela: max(numero_parcela) de todos os recebimentos do mesmo deal/empresa+tipo +1
      const sameGroup = recebimentos.filter(r =>
        r.tipo === sel.tipo &&
        (sel.deal_id ? r.deal_id === sel.deal_id : r.empresa === sel.empresa)
      );
      const maxParcela = Math.max(...sameGroup.map(r => r.numero_parcela));
      setNovaParcelaNum(maxParcela + 1);

      // Busca comissoes pra replicar
      const { data: coms } = await supabase
        .from('comissoes_registros')
        .select('member_id, member_name, role_comissao, percentual, categoria, tipo, observacao, editado_manualmente')
        .eq('recebimento_id', selectedId);

      setComissoesTemplate((coms || []).map((c: any) => ({
        member_id: c.member_id,
        member_name: c.member_name,
        role_comissao: c.role_comissao,
        percentual: Number(c.percentual),
        categoria: c.categoria,
        tipo: c.tipo,
        observacao: c.observacao,
        editado_manualmente: c.editado_manualmente,
      })));
    })();
  }, [selectedId, recebimentos]);

  const recebimentosFiltrados = useMemo(() => {
    const search = buscaEmpresa.toLowerCase().trim();
    if (!search) return recebimentos.slice(0, 100);
    return recebimentos.filter(r => (r.empresa || '').toLowerCase().includes(search)).slice(0, 100);
  }, [recebimentos, buscaEmpresa]);

  const selected = recebimentos.find(r => r.id === selectedId);
  const valorContratoNum = parseFloat(valorContrato) || 0;
  const totalComissoesNovas = comissoesTemplate.reduce(
    (sum, c) => sum + valorContratoNum * c.percentual,
    0
  );

  const handleSubmit = async () => {
    if (!selected) return toast.error('Selecione um recebimento');
    if (!dataPrevista) return toast.error('Informe a data');
    if (valorContratoNum <= 0) return toast.error('Informe o valor');

    setSaving(true);
    try {
      // 1. Cria nova parcela (recebimento)
      const recebPayload: any = {
        deal_id: selected.deal_id,
        tipo: selected.tipo,
        numero_parcela: novaParcelaNum,
        data_prevista: dataPrevista,
        valor_contrato: valorContratoNum,
        empresa: selected.empresa,
        status: 'aguardando',
        observacao: observacao || null,
      };
      const { data: novoReceb, error: rerr } = await supabase
        .from('deal_recebimentos')
        .insert(recebPayload)
        .select()
        .single();
      if (rerr) throw rerr;

      // 2. Se havia comissoes manuais no recebimento anterior, replica
      // (o trigger automatico so roda em INSERT quando deal_id != null E categoria de aquisicao)
      const comissoesManuais = comissoesTemplate.filter(c => c.editado_manualmente);

      if (comissoesManuais.length > 0) {
        const rows = comissoesManuais.map(c => ({
          deal_id: selected.deal_id,
          recebimento_id: novoReceb.id,
          numero_parcela: novaParcelaNum,
          member_id: c.member_id,
          member_name: c.member_name,
          role_comissao: c.role_comissao,
          tipo: c.tipo,
          categoria: c.categoria,
          valor_base: valorContratoNum,
          percentual: c.percentual,
          valor_comissao: valorContratoNum * c.percentual,
          empresa: selected.empresa,
          observacao: observacao || c.observacao,
          editado_manualmente: true,
          status_comissao: 'aguardando_pgto',
          data_pgto: dataPrevista,
          data_liberacao: addDays(dataPrevista, 30),
        }));

        // Pode acontecer de o trigger automatico ter gerado comissoes de closer/sdr
        // antes de chegarmos aqui. Nesse caso, as manuais adicionais passam por cima
        // (nao ha conflito de UNIQUE pois role_comissao difere).
        const { error: cerr } = await supabase.from('comissoes_registros').insert(rows);
        if (cerr) throw cerr;
      }

      toast.success(
        `Parcela ${novaParcelaNum} criada! ${comissoesManuais.length} comissão(ões) replicada(s).`
      );
      onCreated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao criar parcela');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">Adicionar Parcela</h3>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
              Buscar empresa
            </label>
            <input
              type="text"
              value={buscaEmpresa}
              onChange={e => setBuscaEmpresa(e.target.value)}
              placeholder="Digite pra filtrar…"
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>

          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
              Recebimento de origem ({recebimentosFiltrados.length} exibido{recebimentosFiltrados.length === 1 ? '' : 's'})
            </label>
            <select
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            >
              <option value="">{loading ? 'Carregando…' : 'Selecione o recebimento que vai parcelar'}</option>
              {recebimentosFiltrados.map(r => (
                <option key={r.id} value={r.id}>
                  {r.empresa || '(sem empresa)'} · {r.tipo.toUpperCase()} · parcela {r.numero_parcela} · {fmt(r.valor_contrato)} · {r.data_prevista}
                </option>
              ))}
            </select>
          </div>

          {selected && (
            <>
              <div className="p-3 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded">
                <div className="text-white font-semibold">{selected.empresa || '(sem empresa)'}</div>
                <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-0.5">
                  {selected.tipo.toUpperCase()} · parcela atual {selected.numero_parcela} · valor {fmt(selected.valor_contrato)}
                </div>
                <div className="text-[10px] text-emerald-400 mt-0.5">
                  Nova parcela será: <strong>{novaParcelaNum}</strong>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Data prevista</label>
                  <input
                    type="date"
                    value={dataPrevista}
                    min="2020-01-01" max="2050-12-31"
                    onChange={e => {
                      const v = e.target.value;
                      if (v) {
                        const y = parseInt(v.slice(0, 4), 10);
                        if (!Number.isFinite(y) || y < 2020 || y > 2050) return;
                      }
                      setDataPrevista(v);
                    }}
                    className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Valor (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={valorContrato}
                    onChange={e => setValorContrato(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Observação</label>
                <input
                  type="text"
                  value={observacao}
                  onChange={e => setObservacao(e.target.value)}
                  placeholder={`ex: Parcela ${novaParcelaNum}/${novaParcelaNum}`}
                  className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                />
              </div>

              {/* Preview comissoes replicadas */}
              {comissoesTemplate.length > 0 && (
                <div className="p-3 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded">
                  <div className="text-white font-semibold mb-2 text-xs">
                    {comissoesTemplate.filter(c => c.editado_manualmente).length} comissão(ões) manual(is) será(ão) replicada(s)
                  </div>
                  <div className="space-y-1">
                    {comissoesTemplate.map((c, i) => (
                      <div key={i} className="flex justify-between text-[10px]">
                        <span className="text-[var(--color-v4-text-muted)]">
                          {c.member_name} · {c.role_comissao} · {(c.percentual * 100).toFixed(1)}%
                          {!c.editado_manualmente && ' (auto — gerado pelo trigger)'}
                        </span>
                        <span className="text-white">{fmt(valorContratoNum * c.percentual)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 pt-2 border-t border-[var(--color-v4-border)] flex justify-between text-xs">
                    <span className="text-[var(--color-v4-text-muted)]">Total comissões da nova parcela</span>
                    <span className="text-white font-bold">{fmt(totalComissoesNovas)}</span>
                  </div>
                </div>
              )}

              {selected.deal_id && comissoesTemplate.some(c => !c.editado_manualmente) && (
                <div className="p-3 border border-emerald-500/30 bg-emerald-500/5 rounded text-[11px]">
                  <span className="text-emerald-400">✨ Comissões do closer/sdr deste deal</span>
                  <span className="text-[var(--color-v4-text-muted)]"> serão geradas automaticamente pelo trigger ao inserir a nova parcela.</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
            Cancelar
          </button>
          <button onClick={handleSubmit} disabled={saving || !selected}
            className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
            <Save size={12} /> {saving ? 'Salvando...' : `Criar parcela ${novaParcelaNum}`}
          </button>
        </div>
      </div>
    </div>
  );
};
