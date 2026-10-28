// Aviso na tela de Equipe: agentes do 3C que tabularam "Follow" sem usuário vinculado
// (o lead foi movido, mas o responsável não foi trocado). Some sozinho quando o cadastro resolve.
import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';
import { listarPendencias3C, MOTIVO_LABEL, type Pendencia3C } from '../lib/agente3c';
import { KOMMO_BASE } from '../lib/threeC';

export const Agentes3CPendencias: React.FC = () => {
  const { members } = useAppStore();
  const [pend, setPend] = useState<Pendencia3C[]>([]);

  // recarrega quando o cadastro muda (salvar um membro pode resolver a pendência)
  useEffect(() => { listarPendencias3C().then(setPend).catch(() => setPend([])); }, [members]);

  if (!pend.length) return null;
  return (
    <div className="mb-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle size={14} /> Tabulações do 3C sem responsável trocado — vincule o agente no cadastro do membro
      </div>
      {pend.map((p) => (
        <div key={p.agent_ref}>
          agente 3C <b>{p.agent_ref}</b>{p.agent_nome ? <>, nome <b>{p.agent_nome}</b></> : null}: {MOTIVO_LABEL[p.motivo]}
          {' · '}{p.ocorrencias} tabulação(ões), última em {new Date(p.ultima_em).toLocaleString('pt-BR')}
          {p.ultimo_lead_kommo_id ? (
            <> · lead <a className="underline" href={`${KOMMO_BASE}/leads/detail/${p.ultimo_lead_kommo_id}`} target="_blank" rel="noreferrer">{p.ultimo_lead_kommo_id}</a></>
          ) : null}
        </div>
      ))}
    </div>
  );
};
