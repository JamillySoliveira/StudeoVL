/**
 * =======================================================================
 * CONFIGURAÇÃO CENTRALIZADA DA PLATAFORMA VL AUTOMAÇÕES
 * =======================================================================
 * 
 * Este arquivo concentra as constantes globais da plataforma:
 * 1. Número oficial do WhatsApp para atendimento e liberação manual de acessos.
 * 2. Mensagens pré-formatadas para solicitação de acesso aos cursos.
 * 3. Função centralizada de geração de links do WhatsApp (`getCourseWhatsAppUrl`).
 * 4. Avisos gerais da plataforma destinados aos alunos.
 */

/**
 * NÚMERO DO WHATSAPP OFICIAL (CONFIGURAÇÃO ÚNICA NO CÓDIGO)
 * 
 * Todas as telas da plataforma que geram links para o WhatsApp (cards de cursos,
 * botões de compra, telas de curso bloqueado) consomem exclusivamente esta constante.
 * Para atualizar o número de contato da VL Automações no futuro, altere apenas esta linha.
 * Formato internacional: DDI + DDD + Número (apenas dígitos).
 */
export const WHATSAPP_NUMBER = "5512996092249";

/**
 * Mensagens padrão geradas para o aluno iniciar o contato via WhatsApp
 * de acordo com o curso que deseja adquirir.
 */
export const WHATSAPP_COURSE_MESSAGES: Record<string, string> = {
  "rockwell-basico": "Olá! Gostaria de obter acesso ao curso Programação Rockwell - Básico.",
  "rControl-entrada-saida-analogica": "Olá! Gostaria de obter acesso ao curso Controle de Saída e Entrada Analógica.",
  "IHM-supervisorio": "Olá! Gostaria de obter acesso ao curso IHM e Supervisório.",
  // IDs antigos (compatibilidade)
  "rockwell-intermediario": "Olá! Gostaria de obter acesso ao curso Controle de Saída e Entrada Analógica.",
  "rockwell-avancado": "Olá! Gostaria de obter acesso ao curso IHM e Supervisório.",
};

/**
 * Gera a URL oficial da API do WhatsApp (`https://wa.me/...`)
 * com o número oficial configurado e o texto da mensagem codificado em URI.
 * 
 * @param courseId Identificador do curso (ex: "rControl-entrada-saida-analogica")
 * @returns Link seguro para abertura direta no aplicativo do WhatsApp ou WhatsApp Web
 */
export function getCourseWhatsAppUrl(courseId: string): string {
  const message =
    WHATSAPP_COURSE_MESSAGES[courseId] ||
    "Olá! Gostaria de obter acesso ao curso da VL Automação.";
  const encodedText = encodeURIComponent(message);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodedText}`;
}

export interface Notice {
  id: string;
  courseId: string;
  title: string;
  message: string;
  date?: string;      // Texto fixo de data (usado só nos avisos de demonstração)
  createdAt?: string; // Data ISO de criação (avisos salvos no Firestore)
  lessonOrder?: number;
}

/**
 * Avisos de exemplo exibidos SOMENTE para o "Aluno Demonstração".
 * Os avisos reais ficam na coleção "notices" do Firestore (ver lib/noticeService.ts).
 */
export const DEMO_NOTICES: Notice[] = [
  {
    id: "aviso-demo-basico",
    courseId: "rockwell-basico",
    title: "Nova aula disponível",
    message: "Exemplo de aviso: quando o instrutor publicar uma nova aula, você será avisado aqui.",
    date: "Hoje",
  },
  {
    id: "aviso-demo-atividades",
    courseId: "rockwell-basico",
    title: "Atividades práticas",
    message: "Exemplo de aviso: materiais e atividades do Google Forms aparecem por aqui.",
    date: "Recentemente",
  },
];
