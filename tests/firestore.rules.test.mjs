import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, getDocs, collection, deleteDoc, query, where } from "firebase/firestore";

// Testes das regras de segurança do Firestore.
// Rode com:  npm run test:rules
// (o comando sobe o emulador do Firestore, roda este arquivo e desliga o emulador)
const [emuHost, emuPort] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const rulesPath = new URL("../firestore.rules", import.meta.url);

const env = await initializeTestEnvironment({
  projectId: "demo-studeovl",
  firestore: { rules: readFileSync(rulesPath, "utf8"), host: emuHost, port: Number(emuPort) },
});

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users/admin"), { uid: "admin", role: "admin", accessEnabled: true });
  await setDoc(doc(db, "users/alunoA"), { uid: "alunoA", role: "student", accessEnabled: true, enrolledCourses: ["rockwell-basico"] });
  await setDoc(doc(db, "users/legado"), { uid: "legado", role: "student", accessEnabled: true, courseAccess: { "rockwell-controle-analogico-supervisorio": true } });
  await setDoc(doc(db, "users/alunoC"), { uid: "alunoC", role: "student", accessEnabled: true, enrolledCourses: ["rockwell-intermediario"] });
  await setDoc(doc(db, "users/alunoD"), { uid: "alunoD", role: "student", accessEnabled: true, enrolledCourses: ["rControl-entrada-saida-analogica"] });
  await setDoc(doc(db, "lessons/c1"), { courseId: "rControl-entrada-saida-analogica", title: "Controle" });
  await setDoc(doc(db, "lessons/c2"), { courseId: "rockwell-intermediario", title: "Controle antigo" });
  await setDoc(doc(db, "lessons/i1"), { courseId: "IHM-supervisorio", title: "IHM" });
  await setDoc(doc(db, "notices/n1"), { courseId: "rockwell-basico", title: "Aviso", message: "Básico", createdAt: "2026-01-01" });
  await setDoc(doc(db, "notices/n2"), { courseId: "IHM-supervisorio", title: "Aviso", message: "IHM", createdAt: "2026-01-01" });
  await setDoc(doc(db, "users/semcurso"), { uid: "semcurso", role: "student", accessEnabled: true });
  await setDoc(doc(db, "lessons/av1"), { courseId: "rockwell-avancado", title: "Aula avançada", videoUrl: "https://secreto" });
  await setDoc(doc(db, "lessons/leg1"), { courseId: "rockwell-controle-analogico-supervisorio", title: "Aula legada" });
  await setDoc(doc(db, "modules/m1"), { courseId: "rockwell-avancado", lessons: [{ id: "x", videoUrl: "https://secreto" }] });
  await setDoc(doc(db, "courses/rockwell-avancado"), { certificateUrl: "data:secreto" });
  await setDoc(doc(db, "courses/rockwell-basico"), { title: "Básico" });
  await setDoc(doc(db, "users/alunoB"), { uid: "alunoB", role: "student", accessEnabled: true });
  await setDoc(doc(db, "users/bloq"), { uid: "bloq", role: "student", accessEnabled: false });
  await setDoc(doc(db, "progress/alunoB_rockwell-basico"), { userId: "alunoB", courseId: "rockwell-basico", completedLessons: ["x"] });
  await setDoc(doc(db, "lessons/l1"), { courseId: "rockwell-basico", title: "Aula" });
  await setDoc(doc(db, "deletedLessons/d1"), { courseId: "rockwell-basico" });
});

const A = env.authenticatedContext("alunoA").firestore();
const B = env.authenticatedContext("alunoB").firestore();
const ADM = env.authenticatedContext("admin").firestore();
const BLQ = env.authenticatedContext("bloq").firestore();
const ANON = env.unauthenticatedContext().firestore();
const LEG = env.authenticatedContext("legado").firestore();
const SEM = env.authenticatedContext("semcurso").firestore();
const C = env.authenticatedContext("alunoC").firestore();
const D = env.authenticatedContext("alunoD").firestore();
const CONTROLE = ["rControl-entrada-saida-analogica", "rockwell-intermediario"];

const results = [];
async function t(name, p) {
  try { await p; results.push(["OK ", name]); } catch (e) { results.push(["FALHOU", name + " -> " + e.message.split("\n")[0]]); }
}
const prog = (u, c = "rockwell-basico") => ({ userId: u, courseId: c, completedLessons: [] });

// PROGRESSO
await t("A lê o próprio progresso que ainda não existe", assertSucceeds(getDoc(doc(A, "progress/alunoA_rockwell-avancado"))));
await t("A cria o próprio progresso", assertSucceeds(setDoc(doc(A, "progress/alunoA_rockwell-basico"), prog("alunoA"))));
await t("A atualiza o próprio progresso (merge)", assertSucceeds(setDoc(doc(A, "progress/alunoA_rockwell-basico"), { userId: "alunoA", completedLessons: ["l1"] }, { merge: true })));
await t("A NÃO cria doc com ID do B (sequestro)", assertFails(setDoc(doc(A, "progress/alunoB_rockwell-avancado"), prog("alunoA"))));
await t("A NÃO cria doc com userId do B", assertFails(setDoc(doc(A, "progress/alunoA_rockwell-avancado"), prog("alunoB"))));
await t("A NÃO lê progresso do B", assertFails(getDoc(doc(A, "progress/alunoB_rockwell-basico"))));
await t("A NÃO altera progresso do B", assertFails(setDoc(doc(A, "progress/alunoB_rockwell-basico"), prog("alunoA"), { merge: true })));
await t("A NÃO apaga progresso do B", assertFails(deleteDoc(doc(A, "progress/alunoB_rockwell-basico"))));
await t("A NÃO usa prefixo parecido (alunoAB_...)", assertFails(setDoc(doc(A, "progress/alunoAX_rockwell-basico"), prog("alunoA"))));
await t("Admin lê progresso do B", assertSucceeds(getDoc(doc(ADM, "progress/alunoB_rockwell-basico"))));
await t("Anônimo NÃO lê progresso", assertFails(getDoc(doc(ANON, "progress/alunoB_rockwell-basico"))));

// USUÁRIOS
await t("A atualiza o próprio nome (sem enrolledCourses no doc)", assertSucceeds(updateDoc(doc(A, "users/alunoA"), { displayName: "Novo" })));
await t("A NÃO se libera (accessEnabled)", assertFails(updateDoc(doc(BLQ, "users/bloq"), { accessEnabled: true })));
await t("A NÃO se matricula (enrolledCourses)", assertFails(updateDoc(doc(A, "users/alunoA"), { enrolledCourses: ["rockwell-avancado"] })));
await t("Admin matricula aluno", assertSucceeds(updateDoc(doc(ADM, "users/alunoA"), { enrolledCourses: ["rockwell-basico"] })));

// AULAS
await t("Aluno lê aulas do curso matriculado (consulta filtrada)", assertSucceeds(getDocs(query(collection(A, "lessons"), where("courseId", "in", ["rockwell-basico", "rockwell-controle-analogico-supervisorio"])))));
await t("Aluno lê uma aula do curso matriculado", assertSucceeds(getDoc(doc(A, "lessons/l1"))));
await t("Aluno NÃO lê aula de curso não comprado", assertFails(getDoc(doc(A, "lessons/av1"))));
await t("Aluno NÃO lista todas as aulas (sem filtro)", assertFails(getDocs(collection(A, "lessons"))));
await t("Aluno NÃO consulta aulas de curso não comprado", assertFails(getDocs(query(collection(A, "lessons"), where("courseId", "==", "rockwell-avancado")))));
await t("Aluno NÃO lê módulo de curso não comprado", assertFails(getDocs(query(collection(A, "modules"), where("courseId", "in", ["rockwell-avancado"])))));
await t("Aluno NÃO lê certificado de curso não comprado", assertFails(getDoc(doc(A, "courses/rockwell-avancado"))));
await t("Aluno lê dados do curso matriculado", assertSucceeds(getDoc(doc(A, "courses/rockwell-basico"))));
await t("Aluno legado (courseAccess antigo) lê aula legada", assertSucceeds(getDocs(query(collection(LEG, "lessons"), where("courseId", "in", ["rockwell-basico", "rockwell-controle-analogico-supervisorio"])))));
await t("Aluno legado lê curso básico", assertSucceeds(getDoc(doc(LEG, "courses/rockwell-basico"))));
await t("Matrícula com ID antigo (rockwell-intermediario) lê aulas do Controle (ID novo e antigo)", assertSucceeds(getDocs(query(collection(C, "lessons"), where("courseId", "in", CONTROLE)))));
await t("Matrícula com ID novo lê aulas do Controle (ID novo e antigo)", assertSucceeds(getDocs(query(collection(D, "lessons"), where("courseId", "in", CONTROLE)))));
await t("Matrícula com ID novo lê o curso Controle", assertSucceeds(getDoc(doc(D, "courses/rControl-entrada-saida-analogica"))));
await t("Matriculado no Controle NÃO lê aulas do IHM", assertFails(getDoc(doc(D, "lessons/i1"))));
await t("Matriculado no Controle NÃO lê aulas do Básico", assertFails(getDoc(doc(D, "lessons/l1"))));
await t("Aluno ativo sem curso NÃO lê aulas", assertFails(getDoc(doc(SEM, "lessons/l1"))));
await t("Admin lista todas as aulas", assertSucceeds(getDocs(collection(ADM, "lessons"))));
await t("Admin lê todos os cursos", assertSucceeds(getDocs(collection(ADM, "courses"))));
await t("Aluno ativo lê deletedLessons", assertSucceeds(getDocs(collection(A, "deletedLessons"))));
await t("Aluno bloqueado NÃO lê aulas", assertFails(getDocs(query(collection(BLQ, "lessons"), where("courseId", "in", ["rockwell-basico"])))));
await t("Anônimo NÃO lê aulas", assertFails(getDoc(doc(ANON, "lessons/l1"))));
await t("Aluno NÃO se promove a admin", assertFails(updateDoc(doc(A, "users/alunoA"), { role: "admin" })));
await t("Aluno NÃO lê perfil de outro aluno", assertFails(getDoc(doc(A, "users/alunoB"))));
await t("Aluno NÃO cria perfil já liberado", assertFails(setDoc(doc(env.authenticatedContext("novo").firestore(), "users/novo"), { uid: "novo", role: "student", accessEnabled: true })));
await t("Aluno NÃO cria perfil como admin", assertFails(setDoc(doc(env.authenticatedContext("novo2").firestore(), "users/novo2"), { uid: "novo2", role: "admin", accessEnabled: false })));
await t("Novo aluno cria perfil bloqueado", assertSucceeds(setDoc(doc(env.authenticatedContext("novo3").firestore(), "users/novo3"), { uid: "novo3", role: "student", accessEnabled: false })));
await t("Aluno NÃO apaga o próprio perfil", assertFails(deleteDoc(doc(A, "users/alunoA"))));
await t("Aluno NÃO grava em coleção desconhecida", assertFails(setDoc(doc(A, "qualquer/x"), { a: 1 })));
await t("Aluno NÃO grava em deletedLessons", assertFails(setDoc(doc(A, "deletedLessons/l1"), { a: 1 })));
await t("Aluno lê avisos do curso matriculado", assertSucceeds(getDocs(query(collection(A, "notices"), where("courseId", "in", ["rockwell-basico", "rockwell-controle-analogico-supervisorio"])))));
await t("Aluno NÃO lê avisos de curso não comprado", assertFails(getDoc(doc(A, "notices/n2"))));
await t("Aluno NÃO lista todos os avisos", assertFails(getDocs(collection(A, "notices"))));
await t("Aluno NÃO publica aviso", assertFails(setDoc(doc(A, "notices/n3"), { courseId: "rockwell-basico", title: "x", message: "x" })));
await t("Aluno NÃO apaga aviso", assertFails(deleteDoc(doc(A, "notices/n1"))));
await t("Admin publica aviso", assertSucceeds(setDoc(doc(ADM, "notices/n4"), { courseId: "rockwell-basico", title: "Novo", message: "Oi", createdAt: "2026-01-02" })));
await t("Admin NÃO publica aviso sem título", assertFails(setDoc(doc(ADM, "notices/n5"), { courseId: "rockwell-basico", title: "", message: "Oi" })));
await t("Admin lista todos os avisos", assertSucceeds(getDocs(collection(ADM, "notices"))));
await t("Admin apaga aviso", assertSucceeds(deleteDoc(doc(ADM, "notices/n4"))));
await t("Aluno NÃO escreve aula", assertFails(setDoc(doc(A, "lessons/l2"), { title: "x" })));
await t("Admin escreve aula", assertSucceeds(setDoc(doc(ADM, "lessons/l2"), { title: "x", courseId: "rockwell-basico" })));

for (const [s, n] of results) console.log(s, n);
await env.cleanup();
process.exit(results.some(([s]) => s !== "OK ") ? 1 : 0);
