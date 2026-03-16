import React, { useState } from "react";
import { useAppStore } from "../store";
import { Stage } from "../types";
import { X, Save, Building2, Calendar, FileText, Users, Link as LinkIcon, AlertCircle } from "lucide-react";
import toast from "react-hot-toast";

const STAGES: { id: Stage; title: string }[] = [
  { id: "aguardando_comercial", title: "Aguardando Comercial" },
  { id: "atribuir_coordenador", title: "Atribuir Coordenador" },
  { id: "atribuir_equipe", title: "Atribuir Equipe" },
  { id: "criar_workspace", title: "Criar Workspace" },
  { id: "boas_vindas", title: "Boas-vindas" },
  { id: "kickoff", title: "Kickoff" },
  { id: "planejamento", title: "Planejamento" },
  { id: "ongoing", title: "Ongoing" },
];

const PRODUCT_OPTIONS = [
  { id: "ee", label: "Estruturação Estratégica (EE)" },
  { id: "byline", label: "Byline" },
];

export const CreateProjectDrawer: React.FC<{
  onClose: () => void;
}> = ({ onClose }) => {
  const { addProject, members, currentUser } = useAppStore();

  const [isLoading, setIsLoading] = useState(false);

  // Seção 1: Dados do Cliente
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [stage, setStage] = useState<Stage | "">("");

  // Seção 2: Escopo Fechado
  const [produtosEscopo, setProdutosEscopo] = useState<string[]>([]);
  const [valorEscopo, setValorEscopo] = useState<number | "">("");
  const [dataInicioEscopo, setDataInicioEscopo] = useState("");
  const [dataPgtoEscopo, setDataPgtoEscopo] = useState("");

  // Seção 3: Recorrente
  const [produtosRecorrente, setProdutosRecorrente] = useState<string[]>([]);
  const [valorRecorrente, setValorRecorrente] = useState<number | "">("");
  const [dataInicioRecorrente, setDataInicioRecorrente] = useState("");
  const [dataPgtoRecorrente, setDataPgtoRecorrente] = useState("");

  // Seção 4: Atribuições
  const [assignedCoordinatorId, setAssignedCoordinatorId] = useState("");
  const [teamSelection, setTeamSelection] = useState({
    gestor_projetos: "",
    designer: "",
    gestor_trafego: "",
    copywriter: "",
  });

  // Seção 5: Links e Ambientes
  const [kommoLink, setKommoLink] = useState("");
  const [linkCallVendas, setLinkCallVendas] = useState("");
  const [linkTranscricao, setLinkTranscricao] = useState("");
  const [gchatLink, setGchatLink] = useState("");
  const [wppGroupLink, setWppGroupLink] = useState("");
  const [gdriveFolderLink, setGdriveFolderLink] = useState("");
  const [ekyteLink, setEkyteLink] = useState("");
  const [observacoes, setObservacoes] = useState("");

  const isStageAtLeast = (targetStage: Stage) => {
    if (!stage) return false;
    const stageIndex = STAGES.findIndex((s) => s.id === stage);
    const targetIndex = STAGES.findIndex((s) => s.id === targetStage);
    return stageIndex >= targetIndex;
  };

  const isWorkspaceCreatedStage = isStageAtLeast("boas_vindas") || stage === "criar_workspace";

  const handleCreate = async () => {
    if (!clientName.trim()) {
      toast.error("O Nome da Empresa é obrigatório.");
      return;
    }
    if (!stage) {
      toast.error("A Etapa é obrigatória.");
      return;
    }

    setIsLoading(true);

    const productsList = [...produtosEscopo, ...produtosRecorrente];

    // Build workspace status based on stage and filled links
    let workspaceStatus = undefined;
    if (isWorkspaceCreatedStage) {
      workspaceStatus = {
        gchat: gchatLink ? 'created' : 'pending',
        whatsapp: wppGroupLink ? 'created' : 'pending',
        gdrive: gdriveFolderLink ? 'created' : 'pending',
        ekyte: ekyteLink ? 'created' : 'pending',
      };
    }

    const isAfterWelcome = isStageAtLeast("kickoff") || stage === "boas_vindas" || stage === "ongoing";

    const payload: any = {
      name: clientName, // Igual ao nome da empresa
      client_name: clientName,
      client_phone: clientPhone || null,
      stage: stage,
      products: productsList, // Mantem array antigo de produtos para legado se houver
      produtos_escopo: produtosEscopo,
      valor_escopo: valorEscopo !== "" ? valorEscopo : null,
      data_inicio_escopo: dataInicioEscopo || null,
      data_pgto_escopo: dataPgtoEscopo || null,
      produtos_recorrente: produtosRecorrente,
      valor_recorrente: valorRecorrente !== "" ? valorRecorrente : null,
      data_inicio_recorrente: dataInicioRecorrente || null,
      data_pgto_recorrente: dataPgtoRecorrente || null,
      assigned_coordinator_id: assignedCoordinatorId || null,
      kommo_link: kommoLink || null,
      link_call_vendas: linkCallVendas || null,
      link_transcricao: linkTranscricao || null,
      gchat_link: gchatLink || null,
      wpp_group_link: wppGroupLink || null,
      gdrive_folder_link: gdriveFolderLink || null,
      ekyte_link: ekyteLink || null,
      observacoes: observacoes || null,
      workspace_status: workspaceStatus,
      welcome_sent: isAfterWelcome,
      assigned_by_id: currentUser?.id,
    };

    try {
      await addProject(payload, teamSelection);
      toast.success("Projeto criado com sucesso!");
      onClose();
    } catch (e: any) {
      // Error is handled in addProject already, we can just log or stop loading
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleProduct = (
    list: string[],
    setList: React.Dispatch<React.SetStateAction<string[]>>,
    product: string
  ) => {
    if (list.includes(product)) {
      setList(list.filter((p) => p !== product));
    } else {
      setList([...list, product]);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-[var(--color-v4-bg)] border-l border-[var(--color-v4-border)] shadow-2xl z-50 flex flex-col transform transition-transform duration-300 ease-in-out">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[var(--color-v4-border)] bg-[var(--color-v4-card)]">
          <div>
            <h2 className="text-xl font-display font-bold text-white mb-1">
              Criar Projeto Manualmente
            </h2>
            <p className="text-sm text-[var(--color-v4-text-muted)] flex items-center gap-1.5">
              <AlertCircle size={14} className="text-[var(--color-v4-warning)]" />
              Inserção direta (retroativa), sem disparos de Webhook.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[var(--color-v4-surface)] rounded-full text-[var(--color-v4-text-muted)] hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          
          {/* Seção 1: Dados Obrigatórios */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
              <Building2 size={16} /> 1. Dados Iniciais
            </h3>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Nome da Empresa *</label>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Nome do Cliente"
                  className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Telefone Principal</label>
                  <input
                    type="text"
                    value={clientPhone}
                    onChange={(e) => setClientPhone(e.target.value)}
                    placeholder="(00) 00000-0000"
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Etapa Atual do Kanban *</label>
                  <select
                    value={stage}
                    onChange={(e) => setStage(e.target.value as Stage)}
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  >
                    <option value="">Selecione a etapa...</option>
                    {STAGES.map((s) => (
                      <option key={s.id} value={s.id}>{s.title}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </section>

          {/* Seção 2: Escopo Fechado */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
              <FileText size={16} /> 2. Escopo Fechado (Opcional)
            </h3>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-2">Produtos Escopo</label>
                <div className="flex flex-wrap gap-2">
                  {PRODUCT_OPTIONS.map((prod) => (
                    <button
                      key={prod.id}
                      onClick={() => toggleProduct(produtosEscopo, setProdutosEscopo, prod.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-2 transition-all ${
                        produtosEscopo.includes(prod.id)
                          ? "bg-[var(--color-v4-red)]/20 border-[var(--color-v4-red)] text-white"
                          : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:border-slate-500"
                      }`}
                    >
                      {prod.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Valor Escopo (R$)</label>
                  <input
                    type="number"
                    value={valorEscopo}
                    onChange={(e) => setValorEscopo(Number(e.target.value) || "")}
                    placeholder="Ex: 5000"
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Início (Projeto)</label>
                    <input
                      type="date"
                      value={dataInicioEscopo}
                      onChange={(e) => setDataInicioEscopo(e.target.value)}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">1º Pagamento</label>
                    <input
                      type="date"
                      value={dataPgtoEscopo}
                      onChange={(e) => setDataPgtoEscopo(e.target.value)}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Seção 3: Recorrente */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
              <Calendar size={16} /> 3. Recorrente (Opcional)
            </h3>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-2">Produtos Recorrente</label>
                <div className="flex flex-wrap gap-2">
                  {PRODUCT_OPTIONS.map((prod) => (
                    <button
                      key={prod.id}
                      onClick={() => toggleProduct(produtosRecorrente, setProdutosRecorrente, prod.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-2 transition-all ${
                        produtosRecorrente.includes(prod.id)
                          ? "bg-indigo-500/20 border-indigo-500 text-white"
                          : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:border-slate-500"
                      }`}
                    >
                      {prod.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Valor Recorrente (R$)</label>
                  <input
                    type="number"
                    value={valorRecorrente}
                    onChange={(e) => setValorRecorrente(Number(e.target.value) || "")}
                    placeholder="Ex: 2500"
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Início (Projeto)</label>
                    <input
                      type="date"
                      value={dataInicioRecorrente}
                      onChange={(e) => setDataInicioRecorrente(e.target.value)}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">1º Pagamento</label>
                    <input
                      type="date"
                      value={dataPgtoRecorrente}
                      onChange={(e) => setDataPgtoRecorrente(e.target.value)}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Seção 4: Atribuições */}
          {(isStageAtLeast("atribuir_equipe") || stage === "atribuir_coordenador") && (
            <section>
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
                <Users size={16} /> 4. Atribuições (Opcional)
              </h3>
              <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Coordenador de Equipe</label>
                  <select
                    value={assignedCoordinatorId}
                    onChange={(e) => setAssignedCoordinatorId(e.target.value)}
                    className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "coord_equipe" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                  </select>
                </div>
                {isStageAtLeast("atribuir_equipe") && (
                  <div className="pt-4 border-t border-[var(--color-v4-border)] space-y-3">
                    <p className="text-xs text-slate-400">Time / Equipe</p>
                    {["gestor_projetos", "designer", "gestor_trafego", "copywriter"].map((role) => (
                      <div key={role} className="flex flex-col">
                        <label className="text-xs text-[var(--color-v4-text-muted)] mb-1 capitalize">
                          {role.replace("_", " ")}
                        </label>
                        <select
                          value={(teamSelection as any)[role]}
                          onChange={(e) =>
                            setTeamSelection({ ...teamSelection, [role]: e.target.value })
                          }
                          className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                        >
                          <option value="">Selecione...</option>
                          {members
                            .filter((m) => m.role === role && m.isActive)
                            .map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Seção 5: Links e Ambientes */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
              <LinkIcon size={16} /> 5. Links e Ambientes (Opcional)
            </h3>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Link Kommo</label>
                  <input
                    type="url"
                    value={kommoLink}
                    onChange={(e) => setKommoLink(e.target.value)}
                    placeholder="https://..."
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Link Call Vendas</label>
                  <input
                    type="url"
                    value={linkCallVendas}
                    onChange={(e) => setLinkCallVendas(e.target.value)}
                    placeholder="https://..."
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Link Transcrição</label>
                  <input
                    type="url"
                    value={linkTranscricao}
                    onChange={(e) => setLinkTranscricao(e.target.value)}
                    placeholder="https://..."
                    className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  />
                </div>
              </div>
              
              <div className="pt-4 border-t border-[var(--color-v4-border)] space-y-4">
                <p className="text-xs text-slate-400">Ambientes Criados Manualmente (URLs)</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link GChat</label>
                    <input
                      type="url"
                      value={gchatLink}
                      onChange={(e) => setGchatLink(e.target.value)}
                      placeholder="https://..."
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link WhatsApp</label>
                    <input
                      type="url"
                      value={wppGroupLink}
                      onChange={(e) => setWppGroupLink(e.target.value)}
                      placeholder="https://..."
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link GDrive (Pasta)</label>
                    <input
                      type="url"
                      value={gdriveFolderLink}
                      onChange={(e) => setGdriveFolderLink(e.target.value)}
                      placeholder="https://..."
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link Ekyte</label>
                    <input
                      type="url"
                      value={ekyteLink}
                      onChange={(e) => setEkyteLink(e.target.value)}
                      placeholder="https://..."
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-[var(--color-v4-border)]">
                <label className="block text-xs text-slate-400 mb-1">Observações</label>
                <textarea
                  value={observacoes}
                  onChange={(e) => setObservacoes(e.target.value)}
                  placeholder="Observações gerais sobre este projeto inserido manualmente..."
                  className="w-full p-3 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)] min-h-[80px]"
                />
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-[var(--color-v4-border)] bg-[var(--color-v4-card)]">
          <button
            onClick={handleCreate}
            disabled={isLoading}
            className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Save size={18} />
            {isLoading ? "Salvando..." : "Criar Projeto"}
          </button>
        </div>
      </div>
    </>
  );
};
