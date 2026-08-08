// ============================================================================
// Tipos do domínio — SDNA Outbound
// Nomes/campos pensados para mapear diretamente no Kommo (ver docs/PRD.md §6).
// ============================================================================

export type View =
  | 'dashboard'
  | 'leads'
  | 'lead_detalhe'
  | 'workflow'
  | 'arquiteto'
  | 'cadencia'
  | 'cliente_oculto'
  | 'usuarios'
  | 'configuracoes';

export type Role = 'admin' | 'gestor' | 'sdr' | 'viewer';

// Etapas do pipeline — espelham etapas/tags do funil no Kommo.
export type LeadStatus =
  | 'importado'
  | 'validando'
  | 'enriquecendo'
  | 'incompleto' // enriquecimento não completou (alguma consulta falhou) — reprocessar
  | 'enriquecido' // enriquecimento completo (site + social + Lemit)
  | 'descobrindo_decisor'
  | 'cliente_oculto'
  | 'briefing_gerado'
  | 'pronto'
  | 'em_abordagem'
  | 'respondido'
  | 'descartado';

// Qualidade do dado recebido na planilha (a Receita é a fonte de verdade).
// - valido: bate com a Receita, sem ressalvas
// - corrigido: algum dado foi de fato trocado pelo oficial (ex.: razão social)
// - atencao: dado ok, mas há alertas (INAPTA, telefone não-celular, e-mail suspeito)
// - suspeito: não foi possível confirmar na Receita (falha/rate limit)
// - invalido: CNPJ com dígito verificador errado
export type DataQuality = 'valido' | 'corrigido' | 'atencao' | 'suspeito' | 'invalido';

export interface Lead {
  id: string;
  // --- Entrada (planilha) ---
  cnpjRaw: string;
  companyNameRaw: string;
  revenueBandRaw: string | null;
  phoneRaw: string | null;
  emailRaw: string | null;
  siteUrl: string | null; // capturado da planilha (coluna SITE), se houver
  // --- Validado (Receita/BrasilAPI) ---
  cnpj: string | null; // normalizado (só dígitos)
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnae: string | null;
  segmento: string | null;
  cidade: string | null;
  uf: string | null;
  situacaoCadastral: string | null;
  socios: Socio[];
  // --- Redes institucionais da empresa (Fase 2) ---
  companyInstagram: string | null;
  companyFacebook: string | null;
  // --- Empreendimentos e Google Meu Negócio (Fase 2) ---
  empreendimentos: Empreendimento[];
  googleBusiness: GoogleBusiness | null;
  lemitCompany: LemitCompany | null; // dados completos da empresa na Lemit
  // --- DataStone: organograma + porte (Fase 2) ---
  organograma?: Organograma | null;
  datastone?: DatastoneInfo | null;
  // --- Briefing por IA / Data Intel (Fase 2) ---
  briefing?: Briefing | null;
  // --- Metadados ---
  dataQuality: DataQuality;
  validationNotes: string[]; // divergências encontradas
  enrichIssues?: EnrichIssue[]; // plataformas que falharam no último enriquecimento
  anuncios?: AnunciosData | null; // anúncios ativos (Meta Ad Library via headless)
  status: LeadStatus;
  score: number | null;
  kommoLeadId: string | null; // preenchido na integração (Fase 4)
  createdAt: string;
  updatedAt: string;
}

export interface Socio {
  nome: string;
  qualificacao: string | null; // ex.: "Sócio-Administrador"
}

// Anúncios (headless Meta Ad Library) com validação cruzada por pontuação.
export interface AdItem {
  id: string;
  advertiser: string | null; // handle da página anunciante
  dest: string[]; // domínios de destino
  destTipo?: 'whatsapp' | 'lp' | 'perfil'; // para onde o anúncio manda o clique
  midiaTipo?: 'video' | 'imagem' | 'carrossel'; // formato do criativo
  imagem?: string | null; // URL do criativo (carrega no navegador; pode expirar)
  empreendimento: string | null; // empreendimento atribuído (via domínio/copy)
  score: number; // nº de sinais que bateram
  signals: string[]; // ex.: ['conta oficial','domínio da LP']
  trecho: string; // trecho legível do criativo
}
export interface AnunciosMeta {
  total: number | null; // total de anúncios únicos analisados (todos os termos)
  validados: AdItem[]; // alta confiança — 1+ sinal forte e 2+ no total
  aValidar: AdItem[]; // média confiança — 1 sinal forte
  descartados: AdItem[]; // baixa confiança — só sinal fraco/nenhum (mostrados, não jogados fora)
  porEmpreendimento: Record<string, number>;
  termo: string;
  termosBuscados?: string[]; // termos que o Meta respondeu (empresa + empreendimentos)
  termosIgnorados?: string[]; // termos além do teto anti-ban (não buscados)
  // LPs descobertas nos anúncios (destino) e realimentadas nos empreendimentos.
  lpsDescobertas?: Array<{ domain: string; empreendimento: string; novo: boolean }>;
  // Curadoria manual do operador (sobrescreve a classificação automática):
  // { [adId]: 'validado' | 'a_validar' | 'descartado' }
  decisoes?: Record<string, 'validado' | 'a_validar' | 'descartado'>;
}
export interface AnunciosData {
  meta: AnunciosMeta | null;
  checkedAt: string;
}

// Falha de uma plataforma/fonte durante o enriquecimento (mostrada como aviso).
export interface EnrichIssue {
  source: string; // ex.: "DataStone", "Lemit", "Busca (Brave)"
  reason: string; // por que falhou (ex.: "sem créditos — recarregue o saldo")
}

export interface Empreendimento {
  nome: string;
  cidade: string | null;
  status: 'lancamento' | 'em_obra' | 'entregue' | null;
  lp: string | null; // landing page real do empreendimento (quando encontrada)
  lpAudit: EmpreendimentoLpAudit | null; // auditoria da LP (site + WhatsApp + PageSpeed)
}

export interface FormField {
  tipo: string; // text, email, tel, select, textarea…
  nome: string | null; // atributo name
  placeholder: string | null;
}
export interface FormAudit {
  hasForm: boolean;
  viaEmbed: boolean; // form embutido (RD Station/Typeform/HubSpot…) — não dá pra contar campos
  fields: number | null; // nº de campos visíveis (null quando via embed)
  fieldList?: FormField[]; // detalhe de cada campo (tipo/nome/placeholder)
  hasSubmit: boolean;
  actionSuspeita: boolean; // action vazia/#/javascript: → possível form quebrado
  action?: string | null; // destino do form (pra que URL envia)
}
export interface EmpreendimentoLpAudit {
  siteUrl: string | null;
  isOnline: boolean;
  httpsValid: boolean;
  loadTimeMs: number | null;
  whatsappButtons: WhatsappButtonCheck[];
  hasWhatsappWidget: boolean;
  hasMetaPixel: boolean;
  hasGoogleTag: boolean;
  hasGoogleAds?: boolean;
  hasTiktokPixel?: boolean;
  pixelsConfirmed?: boolean; // true = pixels confirmados via headless (rodou o JS)
  form?: FormAudit | null; // formulário de cadastro (captação)
  pagespeed: SitePageSpeed | null; // mobile
  pagespeedDesktop?: SitePageSpeed | null; // desktop
}

export interface LemitPhone {
  numero: string | null;
  whatsapp: boolean;
  ranking: number | null;
}
export interface LemitCarro {
  marca: string | null;
  ano: number | null;
  placa: string | null;
}
export interface LemitCompany {
  phones: LemitPhone[];
  fixos: string[];
  emails: string[];
  endereco: string | null;
  dataFundacao: string | null;
  nomeFantasia: string | null;
  carros: LemitCarro[];
}
export interface LemitPersonData {
  phones: LemitPhone[];
  fixos: string[];
  emails: string[];
  enderecos: string[];
  dataNascimento: string | null;
  renda: number | null;
  ocupacao: string | null;
  situacaoCpf: string | null;
  scoreCredito: string | null;
  vinculos: { nome: string | null; tipo: string | null }[];
  carros: LemitCarro[];
}

export interface GoogleBusiness {
  title: string | null;
  rating: number | null;
  reviews: number | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  cid?: string | null; // id do Google Maps (link direto pro perfil)
  latitude?: number | null;
  longitude?: number | null;
  openingHours?: Record<string, string> | null; // horário por dia, quando disponível
  thumbnail?: string | null; // foto do perfil
}

// --- DataStone: organograma (diretoria + gerência) + porte -------------------
export interface OrganogramaPerson {
  nome: string;
  cargo: string | null;
  participacao?: number | null; // % de participação (diretoria/sócios)
  cpf?: string | null;
  linkedin?: string | null; // reservado — fonte assertiva a definir (Fase futura)
}
export interface Organograma {
  diretoria: OrganogramaPerson[]; // sócios/diretores (Receita)
  gerencia: OrganogramaPerson[]; // funcionários atuais de gestão
}
export interface DatastoneInfo {
  estimatedRevenue: string | null;
  segment: string | null;
  employeeCount: string | null;
  cnaeDescription: string | null;
}

// --- Briefing por IA (Data Intel) — análise estratégica + scripts por canal ---
export interface BriefingScripts {
  ligacao: string | null;
  whatsapp: string | null;
  email: { assunto: string | null; corpo: string | null } | null;
  instagram: string | null;
  linkedin: string | null;
}
export interface Briefing {
  resumo: string | null;
  ramoAtividade: string | null;
  setor: string | null;
  produtosServicos: string | null;
  publicoAlvo: string | null;
  modeloNegocio: string | null;
  diferenciais: string | null;
  mercadoAtuacao: string | null;
  icpPresumido: string | null;
  pontosRapport: string | null;
  tipoVenda: string | null;
  presencaDigital: string | null;
  historia: string | null;
  dores: string[];
  ganchos: string[];
  scripts: BriefingScripts | null;
  model: string | null;
  generatedAt: string;
}

// Contatos do decisor com validação cruzada (Lemit + DataStone).
export interface DecisorPhone {
  numero: string;
  whatsapp: boolean;
  hot: boolean; // "quente" — atividade recente (flag DataStone)
  sources: string[]; // 'lemit' | 'datastone'
  validado: boolean; // confirmado nas DUAS fontes
  selecionado?: boolean; // escolhido pelo operador (F2) para seguir no funil
}
export interface DecisorEmail {
  email: string;
  sources: string[];
  validado: boolean;
  selecionado?: boolean; // escolhido pelo operador (F2) para seguir no funil
}
// Dados completos do decisor na DataStone (paralelo ao LemitPersonData).
export interface DatastonePersonData {
  phones: { numero: string; whatsapp: boolean; hot: boolean }[];
  fixos: string[];
  emails: string[];
  renda: string | null;
  ocupacao: string | null;
  empregador: string | null;
  pep: boolean;
  idade: number | null;
  empresas: { nome: string | null; cnpj: string | null; situacao: string | null; participacao: number | null; cargo: string | null }[];
  familia: { nome: string | null; tipo: string | null }[];
}

// Decisor (pessoa física) — vira um Contato no Kommo (Fase 2).
export interface DecisionMaker {
  id: string;
  leadId: string;
  nome: string;
  cargo: string | null;
  isPrimary: boolean;
  cpf: string | null;
  phonePersonal: string | null;
  phoneWhatsapp: boolean; // o telefone pessoal é WhatsApp? (Lemit)
  emailPersonal: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  confidence: number; // 0-100
  source: string | null;
  kommoContactId: string | null;
  // Escolhido pelo operador (F2) para ser trabalhado nas próximas fases —
  // junto com selecionado dos phones/emails define o que vai pro Kommo.
  selecionado?: boolean;
  // Outras empresas em que o sócio participa (Lemit) — sinal de peso do decisor.
  companiesCount: number;
  companies: SocioCompany[];
  // Dados completos da pessoa na Lemit (todos os telefones, e-mails, etc.).
  lemit: LemitPersonData | null;
  // Contatos com validação cruzada (Lemit + DataStone) e dados da DataStone.
  phones?: DecisorPhone[];
  emails?: DecisorEmail[];
  datastone?: DatastonePersonData | null;
}

export interface SocioCompany {
  nome: string | null;
  cnpj: string | null;
  situacao: string | null;
  participacao: number | null;
}

// Nível de decisor derivado da quantidade de empresas + cargo.
export type DecisorLevel = 'alto' | 'medio' | 'baixo';

// Auditoria de site (Fase 1).
export interface SiteAudit {
  id: string;
  leadId: string;
  siteUrl: string | null;
  // como o site foi obtido: informado | email | busca | palpite | nao_encontrado
  source: string | null;
  isOnline: boolean;
  httpStatus: number | null;
  httpsValid: boolean;
  loadTimeMs: number | null;
  whatsappButtons: WhatsappButtonCheck[];
  // true quando há sinais de WhatsApp (widget/JS) mas o link não está no HTML
  // estático — não deu para validar automaticamente.
  hasWhatsappWidget: boolean;
  hasMetaPixel: boolean;
  hasGoogleTag: boolean;
  hasGoogleAds?: boolean; // conversão do Google Ads (tráfego pago ativo)
  hasTiktokPixel?: boolean;
  // Instagram/Facebook linkados no próprio site (fonte institucional confiável)
  siteInstagram: string | null;
  siteFacebook: string | null;
  // PageSpeed Insights (Google) — notas reais do site
  pagespeed: SitePageSpeed | null;
  checkedAt: string;
  notes: string[];
}

export interface SitePageSpeed {
  performance: number | null; // 0–100
  seo: number | null;
  bestPractices: number | null;
  accessibility: number | null;
  lcpMs: number | null; // Largest Contentful Paint em ms
}

export interface WhatsappButtonCheck {
  href: string;
  numberFound: string | null;
  working: boolean; // link/número válido?
}

// Fila de enriquecimento assíncrono.
export type JobType =
  | 'cnpj'
  | 'decisor'
  | 'site'
  | 'ads'
  | 'benchmark'
  | 'mystery'
  | 'briefing'
  | 'cadence';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface EnrichmentJob {
  id: string;
  leadId: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: Role;
  customPermissions: Partial<Permissions> | null;
  active: boolean;
}

export interface Permissions {
  canViewDashboard: boolean;
  canImport: boolean;
  canViewLeads: boolean;
  canEditLeads: boolean;
  canViewWorkflow: boolean;
  canViewArquiteto: boolean;
  canViewCadencia: boolean;
  canSendCadencia: boolean;
  canViewClienteOculto: boolean;
  canManageUsers: boolean;
  canManageConfig: boolean;
}
