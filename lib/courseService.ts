/**
 * =======================================================================
 * SERVIÇO DE CURSOS, AULAS E ADMINISTRAÇÃO NO FIRESTORE - VL AUTOMAÇÕES
 * =======================================================================
 *
 * Este arquivo gerencia todas as operações de banco de dados sobre cursos e administração:
 * 1. Consulta dos cursos e suas respectivas aulas (com suporte a vídeos do YouTube e Google Drive)
 * 2. Controle de acesso por usuário:
 *    - accessEnabled: define se a conta do aluno está ativa ou bloqueada
 *    - enrolledCourses: define os cursos específicos liberados para aquele aluno
 *    - role: "admin" possui acesso irrestrito a todos os cursos e ao painel de controle
 * 3. Gestão de aulas pelo administrador (adicionar, editar links de vídeo, ordenar e excluir)
 * 4. Gestão de certificados por curso (anexo do PDF oficial disponibilizado pelo administrador)
 * 5. Gerenciamento de alunos e permissões na coleção "users"
 *
 * Utiliza o Cloud Firestore como banco principal e o localStorage como cache rápido.
 */

import {
  db,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
} from "./firebase";

import { Course, Lesson, Module, UserProfile } from "./types";
import {
  AVAILABLE_COURSES,
  INITIAL_COURSE_ID,
  INITIAL_COURSE,
} from "./courseData";
import { clearUserProfileCache } from "./studentService";

// =======================================================================
// CACHE EM MEMÓRIA E DEDUPLICAÇÃO DE REQUISIÇÕES (ALTA PERFORMANCE)
// =======================================================================
const courseCache = new Map<string, { data: Course; timestamp: number }>();
const inFlightCoursePromises = new Map<string, Promise<Course>>();
let inFlightAllCourses: Promise<Course[]> | null = null;
const COURSE_CACHE_TTL = 15 * 1000; // 15 segundos para garantir atualização rápida após edições do admin

/**
 * Limpa o cache em memória dos cursos.
 * Chamado automaticamente em qualquer alteração feita pelo administrador.
 */
export function clearCourseCache(): void {
  courseCache.clear();
  inFlightCoursePromises.clear();
  inFlightAllCourses = null;
}

// Chaves utilizadas para cache no localStorage do navegador
const STORAGE_LESSONS_OVERRIDE_KEY = "vl_lessons_custom_urls";
const STORAGE_COURSE_CERT_PREFIX = "vl_course_cert_";
const STORAGE_DELETED_LESSONS_KEY = "vl_deleted_lessons";

/**
 * Lê do cache local as aulas que foram excluídas pelo administrador.
 */
function getLocalDeletedLessons(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_DELETED_LESSONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Registra o ID da aula excluída no cache local.
 */
function setLocalDeletedLesson(lessonId: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = getLocalDeletedLessons();
    if (!current.includes(lessonId)) {
      current.push(lessonId);
      localStorage.setItem(STORAGE_DELETED_LESSONS_KEY, JSON.stringify(current));
    }
  } catch (error) {
    console.warn("Erro ao salvar aula excluída no cache local:", error);
  }
}

/**
 * Remove o ID da aula do cache local de exclusões (se for recriada).
 */
function removeLocalDeletedLesson(lessonId: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = getLocalDeletedLessons().filter((id) => id !== lessonId);
    localStorage.setItem(STORAGE_DELETED_LESSONS_KEY, JSON.stringify(current));
  } catch (error) {
    console.warn("Erro ao atualizar cache local de aulas excluídas:", error);
  }
}

/**
 * Lê os dados do certificado salvos no cache local do navegador.
 * Evita tela em branco se houver instabilidade momentânea na conexão.
 */
function getLocalCourseCertificate(courseId: string): Partial<Course> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_COURSE_CERT_PREFIX}${courseId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Salva ou remove o certificado do cache local.
 */
function setLocalCourseCertificate(
  courseId: string,
  data: Partial<Course> | null
): void {
  if (typeof window === "undefined") return;
  try {
    if (!data) {
      localStorage.removeItem(`${STORAGE_COURSE_CERT_PREFIX}${courseId}`);
    } else {
      localStorage.setItem(
        `${STORAGE_COURSE_CERT_PREFIX}${courseId}`,
        JSON.stringify(data)
      );
    }
  } catch (error) {
    console.warn("Erro ao salvar cache de certificado:", error);
  }
}

/**
 * Lê do localStorage eventuais edições feitas nas aulas (URLs de vídeos, formulários, títulos).
 */
function getLocalLessonsOverrides(): Record<string, Partial<Lesson>> {
  if (typeof window === "undefined") return {};

  try {
    const raw = localStorage.getItem(STORAGE_LESSONS_OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Atualiza o cache local de uma aula para exibição instantânea.
 */
function setLocalLessonsOverride(
  lessonId: string,
  data: Partial<Lesson>
): void {
  if (typeof window === "undefined") return;

  try {
    const current = getLocalLessonsOverrides();

    current[lessonId] = {
      ...current[lessonId],
      ...data,
    };

    localStorage.setItem(
      STORAGE_LESSONS_OVERRIDE_KEY,
      JSON.stringify(current)
    );
  } catch (error) {
    console.warn("Erro ao salvar cache local de aula:", error);
  }
}

/**
 * IDs antigos/alternativos de curso -> ID oficial do curso (AVAILABLE_COURSES).
 *
 * Os cursos 2 e 3 foram renomeados, mas partes do sistema (matrículas, avisos)
 * ainda usavam os IDs antigos "rockwell-intermediario" e "rockwell-avancado".
 * Isso impedia o aluno matriculado de acessar esses cursos. Todos os IDs
 * abaixo continuam aceitos e são convertidos para o ID oficial.
 */
export const COURSE_ID_ALIASES: Record<string, string> = {
  "rockwell-controle-analogico-supervisorio": "rockwell-basico",
  "rockwell-intermediario": "rControl-entrada-saida-analogica",
  "rockwell-avancado": "IHM-supervisorio",
};

/**
 * Normaliza o ID do curso para o ID oficial, mantendo compatibilidade com dados legados.
 */
export function normalizeCourseId(courseId?: string): string {
  if (!courseId) return INITIAL_COURSE_ID;
  return COURSE_ID_ALIASES[courseId] || courseId;
}

/**
 * Todos os IDs (oficial + antigos) que representam o mesmo curso.
 * Usado nas consultas ao Firestore, pois aulas antigas podem estar gravadas com o ID antigo.
 */
export function getCourseIdVariants(courseId: string): string[] {
  const official = normalizeCourseId(courseId);
  const legacy = Object.keys(COURSE_ID_ALIASES).filter(
    (alias) => COURSE_ID_ALIASES[alias] === official
  );
  return [official, ...legacy];
}

/**
 * Determina quais cursos estão liberados para o aluno visualizar (IDs oficiais).
 *
 * Regras de Acesso:
 * - Se accessEnabled === false, o usuário não acessa nenhum curso.
 * - Administradores (role === "admin") possuem acesso liberado a todos os cursos.
 * - Alunos regulares acessam os cursos listados em `enrolledCourses` ou marcados
 *   como true em `courseAccess` (IDs oficiais ou antigos).
 */
export function getUserAccessibleCourseIds(user: UserProfile | null): string[] {
  if (!user) return [];

  // Se o aluno estiver inativado pelo administrador, bloqueia o acesso
  if (user.accessEnabled === false) return [];

  // Administrador tem acesso a todos os cursos cadastrados
  if (user.role === "admin") {
    return AVAILABLE_COURSES.map((c) => c.id);
  }

  const granted = new Set<string>();
  const enrolled = Array.isArray(user.enrolledCourses) ? user.enrolledCourses : [];
  enrolled.forEach((id) => granted.add(normalizeCourseId(id)));
  Object.entries(user.courseAccess || {}).forEach(([id, allowed]) => {
    if (allowed === true) granted.add(normalizeCourseId(id));
  });

  // Mantém a ordem oficial dos cursos e ignora IDs desconhecidos
  return AVAILABLE_COURSES.map((c) => c.id).filter((id) => granted.has(id));
}

/**
 * Converte a lista de matrículas de um aluno para IDs oficiais (sem duplicados).
 */
export function getUserEnrolledCourseIds(user: UserProfile | null | undefined): string[] {
  if (!user) return [];
  const granted = new Set<string>();
  (Array.isArray(user.enrolledCourses) ? user.enrolledCourses : []).forEach((id) =>
    granted.add(normalizeCourseId(id))
  );
  Object.entries(user.courseAccess || {}).forEach(([id, allowed]) => {
    if (allowed === true) granted.add(normalizeCourseId(id));
  });
  return AVAILABLE_COURSES.map((c) => c.id).filter((id) => granted.has(id));
}

/**
 * Identifica se o usuário atual é uma conta de "Aluno Demonstração".
 * O Aluno Demonstração é uma conta com acesso limitado para conhecer a plataforma
 * e assistir ao vídeo de suporte, sem qualquer acesso aos vídeos das aulas dos cursos.
 */
export function isDemoUser(user: UserProfile | null | undefined): boolean {
  if (!user) return false;
  if (user.uid === "demo-aluno-vl-001") return true;
  const email = (user.email || "").toLowerCase().trim();
  if (email === "aluno.demo@vlautomacao.com.br" || email.startsWith("aluno.demo@")) return true;
  const name = (user.displayName || "").toLowerCase().trim();
  if (name === "aluno demonstração" || name === "aluno demonstracao") return true;
  if ((user as { isDemo?: boolean }).isDemo === true) return true;
  return false;
}

/**
 * Higieniza os dados do curso para o usuário de demonstração.
 * Garante segurança na fonte de dados: remove completamente todas as URLs
 * de vídeo (videoUrl e youtubeUrl) das aulas para que o Aluno Demonstração
 * não receba nem consiga inspecionar os links protegidos.
 */
export function sanitizeCourseForUser(
  course: Course,
  user: UserProfile | null | undefined
): Course {
  if (!isDemoUser(user)) {
    return course;
  }

  // Remove URLs dos vídeos das aulas para o Aluno Demonstração
  const sanitizedLessons = (course.lessons || []).map((lesson) => ({
    ...lesson,
    videoUrl: "",
    youtubeUrl: "",
  }));

  const sanitizedModules = (course.modules || []).map((m) => ({
    ...m,
    lessons: (m.lessons || []).map((lesson) => ({
      ...lesson,
      videoUrl: "",
      youtubeUrl: "",
    })),
  }));

  return {
    ...course,
    lessons: sanitizedLessons,
    modules: sanitizedModules,
  };
}

/**
 * Higieniza uma lista de cursos para o Aluno Demonstração.
 */
export function sanitizeCoursesForUser(
  courses: Course[],
  user: UserProfile | null | undefined
): Course[] {
  if (!isDemoUser(user)) {
    return courses;
  }
  return courses.map((course) => sanitizeCourseForUser(course, user));
}

/**
 * Verifica se um aluno específico possui permissão para acessar determinado curso.
 */
export function checkUserCourseAccess(
  user: UserProfile | null,
  courseId: string = INITIAL_COURSE_ID
): boolean {
  if (!user) return false;
  if (user.accessEnabled === false) return false;
  // Aluno Demonstração nunca possui papel de administrador
  if (user.role === "admin" && !isDemoUser(user)) return true;

  const effectiveCourseId = normalizeCourseId(courseId);
  const accessibleIds = getUserAccessibleCourseIds(user);
  return accessibleIds.includes(effectiveCourseId);
}

/**
 * Monta o objeto final do curso combinando dados base, personalizações do Firestore,
 * aulas adicionadas/atualizadas, exclusões e overrides locais.
 */
/**
 * Monta o objeto final do curso a partir do Firestore.
 * O Firestore é a ÚNICA fonte de verdade para aulas e módulos.
 * Nenhuma aula é inserida a partir de constantes locais ou INITIAL_COURSE.
 */
function assembleCourse(
  effectiveCourseId: string,
  baseCourse: Course,
  firestoreCourseData: Partial<Course> | null,
  firestoreLessons: Lesson[],
  firestoreModules: Module[] = []
): Course {
  const result: Course = {
    id: effectiveCourseId,
    title: firestoreCourseData?.title || baseCourse.title,
    subtitle: firestoreCourseData?.subtitle || baseCourse.subtitle,
    description: firestoreCourseData?.description || baseCourse.description,
    category: firestoreCourseData?.category || baseCourse.category,
    instructor: firestoreCourseData?.instructor || baseCourse.instructor,
    badge: firestoreCourseData?.badge || baseCourse.badge || "",
    totalLessons: 0,
    lessons: [],
    certificateUrl: firestoreCourseData?.certificateUrl || undefined,
    certificateFileName: firestoreCourseData?.certificateFileName || undefined,
    certificateFileSize: firestoreCourseData?.certificateFileSize || undefined,
    certificateUploadedAt: firestoreCourseData?.certificateUploadedAt || undefined,
  };

  // Se não houver certificado no Firestore, busca do cache local de certificados
  if (!result.certificateUrl) {
    const localCert = getLocalCourseCertificate(effectiveCourseId);
    if (localCert?.certificateUrl) {
      result.certificateUrl = localCert.certificateUrl;
      result.certificateFileName = localCert.certificateFileName;
      result.certificateFileSize = localCert.certificateFileSize;
      result.certificateUploadedAt = localCert.certificateUploadedAt;
    }
  }

  // 1. Apenas aulas que vieram do Firestore e pertencem a este curso
  // Deduplica por id e garante ordenação correta
  const lessonsMap = new Map<string, Lesson>();
  firestoreLessons.forEach((l) => {
    if (l && l.id && normalizeCourseId(l.courseId) === effectiveCourseId) {
      lessonsMap.set(l.id, {
        ...l,
        courseId: effectiveCourseId,
        videoUrl: l.videoUrl || l.youtubeUrl || "",
        youtubeUrl: l.youtubeUrl || l.videoUrl || "",
        formUrl: l.formUrl || "",
        title: l.title || "Aula",
        order: typeof l.order === "number" ? l.order : 1,
      });
    }
  });

  const validLessons: Lesson[] = Array.from(lessonsMap.values()).sort(
    (a, b) => (a.order || 0) - (b.order || 0)
  );

  result.lessons = validLessons;
  result.totalLessons = validLessons.length;

  // 2. Módulos do Firestore:
  // Se houver módulos cadastrados no Firestore para este curso, agrupa as aulas
  const courseModules = (firestoreModules || []).filter(
    (m) => normalizeCourseId(m.courseId) === effectiveCourseId
  );

  if (courseModules.length > 0) {
    result.modules = courseModules
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((m) => {
        const moduleLessons = validLessons.filter((l) => l.moduleId === m.id);
        return {
          ...m,
          courseId: effectiveCourseId,
          lessons: moduleLessons,
        };
      });
  } else {
    result.modules = [
      {
        id: "main",
        courseId: effectiveCourseId,
        title: "Aulas",
        order: 1,
        lessons: validLessons,
      },
    ];
  }

  return result;
}

/**
 * Carrega todas as informações de um curso específico diretamente do Cloud Firestore.
 * O Firestore é a fonte de verdade absoluta para cursos, módulos e aulas.
 */
export async function getCourseData(
  courseId: string = INITIAL_COURSE_ID,
  user?: UserProfile | null
): Promise<Course> {
  const effectiveCourseId = normalizeCourseId(courseId);

  // 1. Verifica cache em memória (TTL curto para consistência rápida)
  const cached = courseCache.get(effectiveCourseId);
  if (cached && Date.now() - cached.timestamp < COURSE_CACHE_TTL) {
    return isDemoUser(user)
      ? sanitizeCourseForUser(cached.data, user)
      : cached.data;
  }

  // 2. Se a consulta global de cursos já estiver em andamento, aguarda para evitar requisições duplicadas
  if (inFlightAllCourses) {
    await inFlightAllCourses;
    const postAllCached = courseCache.get(effectiveCourseId);
    if (postAllCached) {
      return isDemoUser(user)
        ? sanitizeCourseForUser(postAllCached.data, user)
        : postAllCached.data;
    }
  }

  // 3. Se já houver promessa em andamento para este curso, reutiliza
  if (inFlightCoursePromises.has(effectiveCourseId)) {
    const active = await inFlightCoursePromises.get(effectiveCourseId)!;
    return isDemoUser(user) ? sanitizeCourseForUser(active, user) : active;
  }

  // 3. Executa a busca otimizada diretamente no Firestore
  const fetchPromise = (async (): Promise<Course> => {
    const baseFound = AVAILABLE_COURSES.find((c) => c.id === effectiveCourseId);
    const baseCourse: Course = baseFound
      ? JSON.parse(JSON.stringify(baseFound))
      : JSON.parse(JSON.stringify(INITIAL_COURSE));

    const localDeleted = getLocalDeletedLessons();
    const deletedLessonIds = new Set<string>(localDeleted);

    try {
      // Executa buscas em paralelo
      const [deletedSnapshot, courseSnapshot, lessonsSnapshot, modulesSnapshot] =
        await Promise.all([
          getDocs(collection(db, "deletedLessons")).catch(() => null),
          getDoc(doc(db, "courses", effectiveCourseId)).catch(() => null),
          getDocs(collection(db, "lessons")).catch(() => null),
          getDocs(collection(db, "modules")).catch(() => null),
        ]);

      if (deletedSnapshot) {
        deletedSnapshot.docs.forEach((dDoc) => {
          const data = dDoc.data();
          const dId = dDoc.id || data.id;
          const dCourseId = data.courseId ? normalizeCourseId(data.courseId) : "";
          if (!dCourseId || dCourseId === effectiveCourseId) {
            deletedLessonIds.add(dId);
            setLocalDeletedLesson(dId);
          }
        });
      }

      const firestoreCourse =
        courseSnapshot && courseSnapshot.exists()
          ? (courseSnapshot.data() as Partial<Course>)
          : null;

      const firestoreLessons: Lesson[] = [];
      if (lessonsSnapshot) {
        lessonsSnapshot.docs.forEach((item) => {
          const data = item.data() as Lesson;
          const lId = item.id || data.id;
          if (deletedLessonIds.has(lId)) return;
          if (normalizeCourseId(data.courseId) === effectiveCourseId) {
            firestoreLessons.push({
              ...data,
              id: lId,
              courseId: effectiveCourseId,
              videoUrl: data.videoUrl || data.youtubeUrl || "",
              youtubeUrl: data.youtubeUrl || data.videoUrl || "",
              formUrl: data.formUrl || "",
            });
          }
        });
      }

      const firestoreModules: Module[] = [];
      if (modulesSnapshot) {
        modulesSnapshot.docs.forEach((mDoc) => {
          const mData = mDoc.data() as Module;
          const mCourseId = normalizeCourseId(mData.courseId);
          if (mCourseId === effectiveCourseId) {
            firestoreModules.push({
              ...mData,
              id: mDoc.id || mData.id,
              courseId: effectiveCourseId,
              lessons: [],
            });
            if (Array.isArray(mData.lessons)) {
              mData.lessons.forEach((l: Lesson) => {
                const lId = l && (l.id || (l as any).uid);
                if (lId && !deletedLessonIds.has(lId)) {
                  firestoreLessons.push({
                    ...l,
                    id: lId,
                    courseId: effectiveCourseId,
                    moduleId: mDoc.id || mData.id,
                    videoUrl: l.videoUrl || l.youtubeUrl || "",
                    youtubeUrl: l.youtubeUrl || l.videoUrl || "",
                    formUrl: l.formUrl || "",
                  });
                }
              });
            }
          }
        });
      }

      const built = assembleCourse(
        effectiveCourseId,
        baseCourse,
        firestoreCourse,
        firestoreLessons,
        firestoreModules
      );

      // Apenas armazena no cache se a consulta do Firestore ocorreu com sucesso sem erros
      if (lessonsSnapshot !== null && courseSnapshot !== null && modulesSnapshot !== null) {
        courseCache.set(effectiveCourseId, {
          data: built,
          timestamp: Date.now(),
        });
      }
      return built;
    } catch (error) {
      console.error("Erro ao carregar dados do curso no Firestore:", error);
      // NUNCA inserir aulas fictícias no fallback
      const emptyFallback: Course = {
        ...baseCourse,
        id: effectiveCourseId,
        lessons: [],
        totalLessons: 0,
        modules: [],
      };
      return emptyFallback;
    }
  })().finally(() => {
    inFlightCoursePromises.delete(effectiveCourseId);
  });

  inFlightCoursePromises.set(effectiveCourseId, fetchPromise);
  const result = await fetchPromise;
  return isDemoUser(user) ? sanitizeCourseForUser(result, user) : result;
}

/**
 * IDs de curso (como gravados no campo courseId do Firestore) que o usuário pode ler.
 *
 * - Admin: retorna null (sem restrição, lê todos os cursos).
 * - Aluno: somente os cursos liberados em enrolledCourses/courseAccess,
 *   incluindo os IDs antigos de cada curso.
 *
 * As regras do Firestore aplicam exatamente a mesma restrição, por isso as
 * consultas do aluno precisam ser filtradas por courseId (senão são negadas).
 */
export function getReadableCourseIds(user: UserProfile | null | undefined): string[] | null {
  if (!user) return [];
  if (user.role === "admin" && !isDemoUser(user)) return null;
  if (isDemoUser(user)) return [];

  // Inclui os IDs antigos, pois aulas antigas podem estar gravadas com eles
  return getUserAccessibleCourseIds(user).flatMap((id) => getCourseIdVariants(id));
}

type SimpleDoc = { id: string; data: () => any };

/**
 * Busca as coleções necessárias no Firestore.
 * - readableIds === null (admin): lê as coleções inteiras.
 * - readableIds = lista (aluno): lê somente as aulas/módulos/cursos liberados.
 * Retorna null em cada posição cuja leitura falhou.
 */
async function fetchCourseCollections(readableIds: string[] | null): Promise<{
  deletedDocs: SimpleDoc[] | null;
  lessonDocs: SimpleDoc[] | null;
  moduleDocs: SimpleDoc[] | null;
  courseDocs: SimpleDoc[] | null;
}> {
  const logAndNull = (label: string) => (err: unknown) => {
    console.error(`Erro ao ler "${label}" no Firestore:`, err);
    return null;
  };

  if (readableIds === null) {
    const [d, l, m, c] = await Promise.all([
      getDocs(collection(db, "deletedLessons")).catch(logAndNull("deletedLessons")),
      getDocs(collection(db, "lessons")).catch(logAndNull("lessons")),
      getDocs(collection(db, "modules")).catch(logAndNull("modules")),
      getDocs(collection(db, "courses")).catch(logAndNull("courses")),
    ]);
    return {
      deletedDocs: d ? d.docs : null,
      lessonDocs: l ? l.docs : null,
      moduleDocs: m ? m.docs : null,
      courseDocs: c ? c.docs : null,
    };
  }

  // Aluno sem nenhum curso liberado: nada para buscar
  if (readableIds.length === 0) {
    return { deletedDocs: [], lessonDocs: [], moduleDocs: [], courseDocs: [] };
  }

  const normalizedIds = Array.from(new Set(readableIds.map((id) => normalizeCourseId(id))));

  const [d, l, m, c] = await Promise.all([
    getDocs(collection(db, "deletedLessons")).catch(logAndNull("deletedLessons")),
    getDocs(query(collection(db, "lessons"), where("courseId", "in", readableIds))).catch(
      logAndNull("lessons")
    ),
    getDocs(query(collection(db, "modules"), where("courseId", "in", readableIds))).catch(
      logAndNull("modules")
    ),
    Promise.all(
      normalizedIds.map((id) =>
        getDoc(doc(db, "courses", id)).catch(logAndNull(`courses/${id}`))
      )
    ),
  ]);

  return {
    deletedDocs: d ? d.docs : null,
    lessonDocs: l ? l.docs : null,
    moduleDocs: m ? m.docs : null,
    courseDocs: c
      .filter((snap): snap is NonNullable<typeof snap> => Boolean(snap && snap.exists()))
      .map((snap) => ({ id: snap.id, data: () => snap.data() })),
  };
}

/**
 * Retorna todos os cursos disponíveis com suas aulas atualizadas exclusivamente do Firestore.
 *
 * Se `user` for informado e não for admin, somente os cursos liberados para ele
 * são buscados; os demais aparecem sem aulas (bloqueados).
 */
export async function getAllCourses(
  user?: UserProfile | null
): Promise<Course[]> {
  const readableIds = user ? getReadableCourseIds(user) : null;
  const isRestricted = readableIds !== null;

  // 1. Cache em memória (somente para a visão completa do admin)
  const now = Date.now();
  const allCached =
    !isRestricted &&
    AVAILABLE_COURSES.every((c) => {
      const cached = courseCache.get(c.id);
      return cached && now - cached.timestamp < COURSE_CACHE_TTL;
    });

  if (allCached) {
    const list = AVAILABLE_COURSES.map((c) => courseCache.get(c.id)!.data);
    return isDemoUser(user) ? sanitizeCoursesForUser(list, user) : list;
  }

  // 2. Se já houver uma busca global em lote em andamento, compartilha a promessa
  if (!isRestricted && inFlightAllCourses) {
    const res = await inFlightAllCourses;
    return isDemoUser(user) ? sanitizeCoursesForUser(res, user) : res;
  }

  // 3. Busca consolidada em lote diretamente no Cloud Firestore
  const fetchPromise = (async (): Promise<Course[]> => {
    const localDeleted = getLocalDeletedLessons();
    const deletedLessonIds = new Set<string>(localDeleted);

    try {
      const { deletedDocs, lessonDocs, moduleDocs, courseDocs } =
        await fetchCourseCollections(readableIds);

      if (deletedDocs) {
        deletedDocs.forEach((dDoc) => {
          const data = dDoc.data();
          const dId = dDoc.id || data.id;
          deletedLessonIds.add(dId);
          setLocalDeletedLesson(dId);
        });
      }

      // Mapeia todas as aulas de todos os cursos que existem no Firestore
      const allFirestoreLessons: Lesson[] = [];
      if (lessonDocs) {
        lessonDocs.forEach((item) => {
          const data = item.data() as Lesson;
          const lId = item.id || data.id;
          if (deletedLessonIds.has(lId)) return;
          allFirestoreLessons.push({
            ...data,
            id: lId,
            courseId: normalizeCourseId(data.courseId),
            videoUrl: data.videoUrl || data.youtubeUrl || "",
            youtubeUrl: data.youtubeUrl || data.videoUrl || "",
            formUrl: data.formUrl || "",
          });
        });
      }

      const allFirestoreModules: Module[] = [];
      if (moduleDocs) {
        moduleDocs.forEach((mDoc) => {
          const mData = mDoc.data() as Module;
          const mCourseId = normalizeCourseId(mData.courseId);
          allFirestoreModules.push({
            ...mData,
            id: mDoc.id || mData.id,
            courseId: mCourseId,
            lessons: [],
          });
          if (Array.isArray(mData.lessons)) {
            mData.lessons.forEach((l: Lesson) => {
              const lId = l && (l.id || (l as any).uid);
              if (lId && !deletedLessonIds.has(lId)) {
                allFirestoreLessons.push({
                  ...l,
                  id: lId,
                  courseId: mCourseId,
                  moduleId: mDoc.id || mData.id,
                  videoUrl: l.videoUrl || l.youtubeUrl || "",
                  youtubeUrl: l.youtubeUrl || l.videoUrl || "",
                  formUrl: l.formUrl || "",
                });
              }
            });
          }
        });
      }

      const coursesMapData = new Map<string, Partial<Course>>();
      if (courseDocs) {
        courseDocs.forEach((docSnap) => {
          coursesMapData.set(docSnap.id, docSnap.data() as Partial<Course>);
        });
      }

      const fetchOk = lessonDocs !== null && moduleDocs !== null && courseDocs !== null;

      const assembledCourses: Course[] = AVAILABLE_COURSES.map((c) => {
        const cCourseId = c.id;
        const firestoreCourseData = coursesMapData.get(cCourseId) || null;
        const relevantLessons = allFirestoreLessons.filter(
          (les) => normalizeCourseId(les.courseId) === cCourseId
        );
        const relevantModules = allFirestoreModules.filter(
          (m) => normalizeCourseId(m.courseId) === cCourseId
        );

        const built = assembleCourse(
          cCourseId,
          c,
          firestoreCourseData,
          relevantLessons,
          relevantModules
        );

        // Cache apenas da visão completa (admin) e somente se a leitura ocorreu sem erros
        if (!isRestricted && fetchOk) {
          courseCache.set(cCourseId, {
            data: built,
            timestamp: Date.now(),
          });
        }
        return built;
      });

      return assembledCourses;
    } catch (error) {
      console.error("Erro ao carregar todos os cursos do Firestore:", error);
      return AVAILABLE_COURSES.map((c) => ({
        ...c,
        lessons: [],
        totalLessons: 0,
        modules: [],
      }));
    }
  })();

  if (!isRestricted) {
    inFlightAllCourses = fetchPromise.finally(() => {
      inFlightAllCourses = null;
    });
  }

  const allResult = await fetchPromise;
  return isDemoUser(user) ? sanitizeCoursesForUser(allResult, user) : allResult;
}

/**
 * Salva ou atualiza a URL do vídeo de uma aula (suporta YouTube e Google Drive).
 * Chamado pelo administrador para disponibilizar a gravação da aula.
 */
export async function saveLessonVideoUrl(
  lessonId: string,
  videoUrl: string,
  courseId: string = INITIAL_COURSE_ID
): Promise<void> {
  const cleanUrl = videoUrl.trim();
  const effectiveCourseId = normalizeCourseId(courseId);

  setLocalLessonsOverride(lessonId, {
    videoUrl: cleanUrl,
    youtubeUrl: cleanUrl,
  });

  clearCourseCache();

  try {
    const lessonRef = doc(db, "lessons", lessonId);
    await setDoc(
      lessonRef,
      {
        id: lessonId,
        courseId: effectiveCourseId,
        videoUrl: cleanUrl,
        youtubeUrl: cleanUrl,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Erro ao salvar link de vídeo no Firestore:", error);
    throw error;
  }
}

/**
 * Atualiza campos específicos de uma aula (título, descrição, formulário, etc.).
 */
export async function updateLessonDetails(
  lessonId: string,
  data: Partial<Lesson>
): Promise<void> {
  const syncedData = {
    ...data,
    ...(data.videoUrl ? { youtubeUrl: data.videoUrl } : {}),
    ...(data.youtubeUrl ? { videoUrl: data.youtubeUrl } : {}),
  };

  setLocalLessonsOverride(lessonId, syncedData);
  clearCourseCache();

  try {
    const lessonRef = doc(db, "lessons", lessonId);
    await setDoc(
      lessonRef,
      {
        ...syncedData,
        id: lessonId,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Erro ao salvar detalhes da aula no Firestore:", error);
    throw error;
  }
}

/* ============================================================
   OPERAÇÕES ADMINISTRATIVAS DE AULAS
   ============================================================ */

/**
 * Cria uma nova aula diretamente vinculada a um curso no Firestore.
 */
export async function addLesson(lesson: Lesson): Promise<void> {
  const effectiveCourseId = normalizeCourseId(lesson.courseId);
  const lessonRef = doc(db, "lessons", lesson.id);

  const cleanVideo = (lesson.videoUrl || lesson.youtubeUrl || "").trim();

  const payload: Lesson = {
    ...lesson,
    courseId: effectiveCourseId,
    videoUrl: cleanVideo,
    youtubeUrl: cleanVideo,
  };

  clearCourseCache();

  await setDoc(lessonRef, {
    ...payload,
    updatedAt: new Date().toISOString(),
  });

  // Se a aula foi recriada, remove do registro de aulas excluídas caso estivesse lá
  try {
    const deletedRef = doc(db, "deletedLessons", lesson.id);
    await deleteDoc(deletedRef);
    removeLocalDeletedLesson(lesson.id);
  } catch {
    // Ignora se não existia em deletedLessons
  }

  setLocalLessonsOverride(lesson.id, {
    videoUrl: cleanVideo,
    youtubeUrl: cleanVideo,
    title: lesson.title,
    duration: lesson.duration,
    formUrl: lesson.formUrl,
    order: lesson.order,
  });
}

/**
 * Atualiza os dados de uma aula no Firestore.
 */
export async function updateLesson(
  lessonId: string,
  data: Partial<Lesson>
): Promise<void> {
  const lessonRef = doc(db, "lessons", lessonId);

  const syncedData = {
    ...data,
    ...(data.videoUrl ? { youtubeUrl: data.videoUrl } : {}),
    ...(data.youtubeUrl ? { videoUrl: data.youtubeUrl } : {}),
  };

  clearCourseCache();

  await setDoc(
    lessonRef,
    {
      ...syncedData,
      id: lessonId,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  setLocalLessonsOverride(lessonId, syncedData);
}

/**
 * Exclui uma aula:
 * 1. Remove da coleção "lessons" do Firestore.
 * 2. Registra o ID da aula na coleção "deletedLessons" do Firestore (mantendo courseId e moduleId para identificação).
 * 3. Remove qualquer override local relacionado à aula.
 */
export async function deleteLesson(
  lessonId: string,
  courseId?: string,
  moduleId?: string
): Promise<void> {
  clearCourseCache();

  // 1. Identifica courseId e moduleId da aula a ser excluída
  const targetCourseId = courseId ? normalizeCourseId(courseId) : "";
  const targetModuleId = moduleId || "";

  // 2. Exclui a aula da coleção 'lessons' no Firestore
  try {
    const lessonRef = doc(db, "lessons", lessonId);
    await deleteDoc(lessonRef);
  } catch (error) {
    console.error("Erro ao remover a aula da coleção lessons:", error);
    throw error;
  }

  // 3. Registra o ID da aula na coleção 'deletedLessons' do Firestore para persistência definitiva
  try {
    const deletedRef = doc(db, "deletedLessons", lessonId);
    await setDoc(
      deletedRef,
      {
        id: lessonId,
        courseId: targetCourseId,
        moduleId: targetModuleId,
        deletedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Erro ao registrar aula em deletedLessons:", error);
    throw error;
  }

  // 4. Limpa caches
  setLocalDeletedLesson(lessonId);
  clearCourseCache();
}

/**
 * Atualiza a sequência/ordem numérica de exibição de uma lista de aulas.
 */
export async function updateLessonsOrder(
  orderedLessons: { id: string; order: number }[]
): Promise<void> {
  clearCourseCache();
  for (const item of orderedLessons) {
    await updateLesson(item.id, { order: item.order });
  }
}

/* ============================================================
   GESTÃO DE CERTIFICADOS PELO ADMINISTRADOR
   ============================================================ */

/**
 * Vincula o arquivo de certificado cadastrado pelo administrador ao curso.
 * Salva na coleção "courses" do Firestore e no cache local.
 */
export async function saveCourseCertificate(
  courseId: string,
  certData: {
    certificateUrl: string;
    certificateFileName: string;
    certificateFileSize?: string;
  }
): Promise<void> {
  const effectiveCourseId = normalizeCourseId(courseId);
  const payload = {
    certificateUrl: certData.certificateUrl,
    certificateFileName: certData.certificateFileName,
    certificateFileSize: certData.certificateFileSize || "",
    certificateUploadedAt: new Date().toISOString(),
  };

  setLocalCourseCertificate(effectiveCourseId, payload);
  clearCourseCache();

  try {
    const courseRef = doc(db, "courses", effectiveCourseId);
    await setDoc(courseRef, payload, { merge: true });
  } catch (error) {
    // Desfaz o cache local para não exibir um certificado que não foi salvo
    setLocalCourseCertificate(effectiveCourseId, null);
    console.error("Erro ao salvar certificado no Firestore:", error);
    throw error;
  }
}

/**
 * Remove o arquivo de certificado associado ao curso.
 */
export async function removeCourseCertificate(courseId: string): Promise<void> {
  const effectiveCourseId = normalizeCourseId(courseId);

  setLocalCourseCertificate(effectiveCourseId, null);
  clearCourseCache();

  try {
    const courseRef = doc(db, "courses", effectiveCourseId);
    await setDoc(
      courseRef,
      {
        certificateUrl: "",
        certificateFileName: "",
        certificateFileSize: "",
        certificateUploadedAt: "",
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Erro ao remover certificado do Firestore:", error);
    throw error;
  }
}

/* ============================================================
   GESTÃO DE ALUNOS E PERMISSÕES (PAINEL ADMINISTRATIVO)
   ============================================================ */

/**
 * Busca a lista de todos os usuários registrados no sistema.
 * Utilizado pelo administrador para gerenciar matrículas e acessos.
 */
export async function fetchAllUsers(): Promise<UserProfile[]> {
  try {
    const usersCol = collection(db, "users");
    const snapshot = await getDocs(usersCol);

    const users: UserProfile[] = [];
    snapshot.forEach((item) => {
      users.push(item.data() as UserProfile);
    });

    return users;
  } catch (error) {
    console.warn("Aviso ao buscar usuários no Firestore:", error);
    return [];
  }
}

/**
 * Ativa ou suspende o acesso de um aluno à plataforma (campo accessEnabled).
 */
export async function toggleUserAccess(
  userId: string,
  accessEnabled: boolean
): Promise<void> {
  clearUserProfileCache(userId);
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      accessEnabled,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erro ao atualizar status de acesso do usuário:", error);
    throw error;
  }
}

/**
 * Atualiza a lista de cursos liberados para determinado aluno (campo enrolledCourses).
 */
export async function updateUserEnrolledCourses(
  userId: string,
  enrolledCourses: string[]
): Promise<void> {
  clearUserProfileCache(userId);

  // Grava sempre os IDs oficiais dos cursos
  const officialIds = Array.from(new Set(enrolledCourses.map((id) => normalizeCourseId(id))));

  // courseAccess: um booleano por curso (IDs oficiais e antigos, para compatibilidade)
  const courseAccess: Record<string, boolean> = {};
  AVAILABLE_COURSES.forEach((c) => {
    getCourseIdVariants(c.id).forEach((variant) => {
      courseAccess[variant] = officialIds.includes(c.id);
    });
  });

  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      enrolledCourses: officialIds,
      courseAccess,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erro ao atualizar cursos matriculados do usuário:", error);
    throw error;
  }
}

/* ============================================================
   COMPATIBILIDADE RETROATIVA
   ============================================================ */

export async function addModule(courseId: string, module: Module): Promise<void> {
  clearCourseCache();
  const moduleRef = doc(db, "modules", module.id);
  await setDoc(moduleRef, {
    ...module,
    courseId,
    lessons: [],
    updatedAt: new Date().toISOString(),
  });
}

export async function updateModule(
  moduleId: string,
  data: Partial<Module>
): Promise<void> {
  clearCourseCache();
  const moduleRef = doc(db, "modules", moduleId);
  await setDoc(
    moduleRef,
    {
      ...data,
      id: moduleId,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

export async function deleteModule(moduleId: string): Promise<void> {
  clearCourseCache();
  const moduleRef = doc(db, "modules", moduleId);
  await deleteDoc(moduleRef);
}

export async function saveCourseStructure(course: Course): Promise<void> {
  clearCourseCache();
  const courseRef = doc(db, "courses", course.id);
  await setDoc(
    courseRef,
    {
      id: course.id,
      title: course.title,
      subtitle: course.subtitle,
      description: course.description,
      category: course.category,
      instructor: course.instructor,
      badge: course.badge,
      totalLessons: course.totalLessons,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}
