-- migration_073_cadencia_closer_base_csv.sql
-- Recarrega kommo.cadencia_closer_base a partir do CSV real "Follow-up 2.0 Closer".
-- Só o CONTEÚDO de fallback (nomes de card + scripts condensados + janelas por balde).
-- NÃO altera cérebro/edge/triggers. offset_days = dias ABSOLUTOS a partir da entrada no balde
-- (a data real vem do plano da IA quando existir; isto é só o fallback).
-- Janelas do CSV: ALTA = fecha em 1-10 dias · MÉDIA = 11-30 dias · BAIXA = >30 dias.
-- Canal por card conforme o CSV (nem todo follow é ligação: Case+áudio e Fim de semana são WhatsApp).
-- MARCAR_CALL não existe no CSV -> preservado como está (P1/P2/P3).

DELETE FROM kommo.cadencia_closer_base WHERE balde IN ('ALTA','MEDIA','BAIXA','CONTRATO');

INSERT INTO kommo.cadencia_closer_base (balde, slot, ord, offset_days, weekday, text) VALUES
-- ===================== ALTA — ALTA PRIORIDADE (fecha em 1-10 dias) =====================
('ALTA','A1',1,2,NULL,'CLOSER · ALTA · Follow 1 (Case + áudio) — WhatsApp: mande um case de segmento parecido + áudio pressionando; adicione no LinkedIn e siga no Instagram. Áudio: lembrei de você, meu time está empolgado pra avançar — ficou alguma dúvida na proposta, o que preciso correr pra fecharmos?'),
('ALTA','A2',2,4,NULL,'CLOSER · ALTA · Dúvidas & Fechamento (opcional) — Entre na call, relembre os pontos da última reunião e direcione pro fechamento.'),
('ALTA','A3',3,5,NULL,'CLOSER · ALTA · Follow 2 (Ligação) — Ligue (tente 3x). Script: batemos um papo sobre resolver [dor 1] e [dor 2], meu time está pronto pra dar o play. Surgiu alguma dúvida? Se postergar, lembre o acordo de assinar até [data] (pode assinar e iniciar depois).'),
('ALTA','A4',4,7,NULL,'CLOSER · ALTA · Follow 3 (Fim de semana) — WhatsApp no sábado, agregue valor sem apertar: EP O Conselho / João Branco, ou artigo da McKinsey do segmento do lead. Lembrei de você, curte no fim de semana.'),
('ALTA','A5',5,9,NULL,'CLOSER · ALTA · Follow 4 (Relembrar deadline) — Ligue 3x; não atendeu → WhatsApp. Aperte no prazo: sua melhor data é o dia X, alinhamos assinatura até amanhã; meu financeiro está apertando no desconto. Bora vender mais?'),
('ALTA','A6',6,10,NULL,'CLOSER · ALTA · Follow 5 (Follow ou demissão) — Se há potencial: teatro de estender a proposta por + Z dias, sempre com deadline. Se sumiu: demita — acredito que a proposta reduzida não fez sentido, vou remover o desconto; sigo atento pra voltarmos no futuro.'),
-- ===================== MÉDIA — MÉDIA PRIORIDADE (fecha em 11-30 dias) — Follow-up pós-reunião =====================
('MEDIA','M1',1,2,NULL,'CLOSER · MÉDIA · Follow 1 (Case + áudio) — WhatsApp: case de segmento parecido + áudio; adicione no LinkedIn e siga no Instagram. Áudio: lembrei de você, alinhei um time de ponta aqui; surgiu alguma dúvida no nosso projeto?'),
('MEDIA','M2',2,5,NULL,'CLOSER · MÉDIA · Dúvidas & Fechamento (opcional) — Entre na call, relembre os pontos da última reunião e direcione pro fechamento.'),
('MEDIA','M3',3,8,NULL,'CLOSER · MÉDIA · Follow 2 (Ligação) — Ligue (tente 3x). Script: batemos um papo sobre resolver [dor 1] e [dor 2], meu time está pronto. Surgiu alguma dúvida? Se postergar, lembre o acordo de assinar até [data] (pode assinar e iniciar depois).'),
('MEDIA','M4',4,11,NULL,'CLOSER · MÉDIA · Follow 3 (Fim de semana) — WhatsApp no sábado, agregue valor sem apertar: EP O Conselho, ou artigo da McKinsey do segmento do lead. Lembrei de você, curte no fim de semana.'),
('MEDIA','M5',5,14,NULL,'CLOSER · MÉDIA · Follow 4 (Conteúdo) — Envie cases/vídeos/artigos da McKinsey via WhatsApp, se coloque à disposição e relembre que o time está pronto.'),
('MEDIA','M6',6,17,NULL,'CLOSER · MÉDIA · Follow 5 (Metas profissionais) — Retome as metas profissionais que você captou na reunião e mostre como a V4 ajuda a atingi-las.'),
('MEDIA','M7',7,21,NULL,'CLOSER · MÉDIA · Follow 6 (Conteúdo) — Novamente cases/vídeos/artigos da McKinsey via WhatsApp; mostre que você está por aí e o time pronto.'),
('MEDIA','M8',8,24,NULL,'CLOSER · MÉDIA · Follow 7 (Conexão) — Ligue 3x; não atendeu → WhatsApp. Conecte no LinkedIn e siga no Instagram; retome o prazo acordado.'),
('MEDIA','M9',9,27,NULL,'CLOSER · MÉDIA · Follow 8 (Relembrar deadline) — Ligue 3x; não atendeu → WhatsApp. Aperte no prazo: sua melhor data é o dia X, alinhamos assinatura; financeiro apertando no desconto. Bora vender mais?'),
('MEDIA','M10',10,30,NULL,'CLOSER · MÉDIA · Follow 9 (Follow ou demissão) — Se há potencial: teatro de estender a proposta por + Z dias com deadline. Se sumiu: demita com elegância e sinalize retomada futura.'),
-- ===================== BAIXA — BAIXA PRIORIDADE (fecha em >30 dias) =====================
('BAIXA','B1',1,2,NULL,'CLOSER · BAIXA · Follow 1 (Case + áudio) — WhatsApp: case de segmento parecido + áudio; adicione no LinkedIn e siga no Instagram. Áudio: lembrei de você, alinhei um time de ponta; surgiu alguma dúvida por aí?'),
('BAIXA','BW1',2,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material GENÉRICO pra o lead lembrar que você existe (case atualizado, vídeo de evento V4, episódio ROI Hunters). Não personalize; objetivo é aquecer no longo prazo pra puxar levantadas de mão.'),
('BAIXA','BW2',3,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW3',4,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW4',5,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW5',6,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW6',7,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW7',8,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
('BAIXA','BW8',9,NULL,3,'CLOSER · BAIXA · Follow Semanal Infinito (quarta) — Material genérico de nutrição (case, evento V4, ROI Hunters).'),
-- ===================== CONTRATO NA RUA — Follow-up contrato na rua =====================
('CONTRATO','C1',1,1,NULL,'CLOSER · CONTRATO · Dia 1 (Aviso) — Contrato liberado: envie o link de assinatura (ClickSign) no WhatsApp + áudio. Meu time liberou o contrato pra você assinar, é super simples, 1 ou 2 cliques via ClickSign. Me avisa que já peço pro time avançar.'),
('CONTRATO','C2',2,2,NULL,'CLOSER · CONTRATO · Dia 2 (Aperto) — WhatsApp: Opa, surgiu alguma dúvida por aí? Destrave a assinatura.'),
('CONTRATO','C3',3,3,NULL,'CLOSER · CONTRATO · Dia 3 (Aperto) — WhatsApp: separamos um dos nossos melhores times pra te atender e a operação está questionando por aqui (são disputados). Consegue matar isso hoje?');
