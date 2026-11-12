/**
 * =======================================================================
 * SERVIÇO DE AVISOS (COMUNICADOS) - VL AUTOMAÇÕES
 * =======================================================================
 *
 * Os avisos ficam na coleção "notices" do Firestore, para que o aviso criado
 * pelo administrador chegue a todos os alunos do curso em tempo real.
 * (Antes ficavam no localStorage do navegador do admin e os alunos nunca viam.)
 *
 * Documento: { courseId, title, message, createdAt (ISO) }
 * Regras: admin cria/exclui; aluno ativo lê somente avisos dos cursos em que está matriculado.
 */

import {
  db,
  collection,
  doc,
  addDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
} from "./firebase";
import { Notice } from "./constants";
import { normalizeCourseId } from "./courseService";

const NOTICES_COLLECTION = "notices";

/**
 * Formata a data de criação do aviso para exibição (ex.: "Hoje", "Ontem", "12/11/2026").
 */
export function formatNoticeDate(notice: Notice): string {
  if (!notice.createdAt) return notice.date || "";
  const created = new Date(notice.createdAt);
  if (Number.isNaN(created.getTime())) return notice.date || "";

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(created)) / 86400000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  return created.toLocaleDateString("pt-BR");
}

/**
 * Acompanha os avisos em tempo real.
 *
 * @param readableCourseIds null = admin (todos os avisos); lista = aluno (somente esses cursos,
 *                          incluindo IDs antigos dos cursos).
 * @returns função para encerrar o acompanhamento
 */
export function subscribeNotices(
  readableCourseIds: string[] | null,
  onChange: (notices: Notice[]) => void
): () => void {
  if (readableCourseIds !== null && readableCourseIds.length === 0) {
    onChange([]);
    return () => {};
  }

  const colRef = collection(db, NOTICES_COLLECTION);
  const target =
    readableCourseIds === null
      ? colRef
      : query(colRef, where("courseId", "in", readableCourseIds));

  return onSnapshot(
    target,
    (snap) => {
      const list: Notice[] = snap.docs.map((d) => {
        const data = d.data() as Partial<Notice>;
        return {
          id: d.id,
          courseId: normalizeCourseId(data.courseId),
          title: data.title || "",
          message: data.message || "",
          createdAt: data.createdAt,
          date: data.date || "",
        };
      });
      // Mais recentes primeiro
      list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      onChange(list);
    },
    (err) => {
      console.error("Erro ao carregar avisos do Firestore:", err);
      onChange([]);
    }
  );
}

/**
 * Cria um aviso para os alunos de um curso (somente admin).
 */
export async function createNotice(data: {
  courseId: string;
  title: string;
  message: string;
}): Promise<void> {
  await addDoc(collection(db, NOTICES_COLLECTION), {
    courseId: normalizeCourseId(data.courseId),
    title: data.title.trim(),
    message: data.message.trim(),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Exclui um aviso (somente admin).
 */
export async function deleteNotice(noticeId: string): Promise<void> {
  await deleteDoc(doc(db, NOTICES_COLLECTION, noticeId));
}
