/**
 * Arquivo de configuração e inicialização do Firebase para a VL AUTOMAÇÕES.
 *
 * Aqui nós configuramos a conexão com o Firebase Authentication (para login dos alunos)
 * e com o Cloud Firestore (banco de dados onde ficam salvos os cursos, módulos, aulas e o progresso).
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithCredential,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
} from "firebase/firestore";

// Importa as configurações geradas automaticamente pelo ambiente
import firebaseConfigJson from "../firebase-applet-config.json";

// Tratamento e garantia do domínio de autenticação e identificação do projeto Firebase "studeo-vl"
// Assegura que em qualquer ambiente (desenvolvimento ou publicado em studeo-vl.ai.studio),
// o authDomain utilize confiavelmente o domínio oficial do projeto: "studeo-vl.firebaseapp.com"
const resolvedAuthDomain =
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
  firebaseConfigJson.authDomain ||
  "studeo-vl.firebaseapp.com";

const resolvedProjectId =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  firebaseConfigJson.projectId ||
  "studeo-vl";

// Dados de configuração da aplicação no Firebase
const firebaseConfig = {
  apiKey: firebaseConfigJson.apiKey,
  authDomain: resolvedAuthDomain,
  projectId: resolvedProjectId,
  storageBucket: firebaseConfigJson.storageBucket || `${resolvedProjectId}.firebasestorage.app`,
  messagingSenderId: firebaseConfigJson.messagingSenderId,
  appId: firebaseConfigJson.appId,
};

// Evita inicializar o Firebase mais de uma vez caso a página recarregue
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Inicializa a autenticação
export const auth = getAuth(app);

// Provedor de login com o Google
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: "select_account",
});

// Inicializa o Cloud Firestore usando o banco padrão do projeto Firebase
export const db = getFirestore(app);

// Desenvolvimento/testes: usa os emuladores locais do Firebase em vez do projeto real.
// Ative com NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true (nunca em produção).
if (
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true" &&
  typeof window !== "undefined" &&
  !(globalThis as { __vlEmulatorsConnected?: boolean }).__vlEmulatorsConnected
) {
  (globalThis as { __vlEmulatorsConnected?: boolean }).__vlEmulatorsConnected = true;
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8085);

  // Atalho de login usado pelos testes automatizados (só existe no modo emulador):
  // o emulador do Auth aceita uma credencial Google falsa em formato JSON.
  (window as unknown as { __vlEmulatorSignIn?: unknown }).__vlEmulatorSignIn = (
    email: string,
    name: string
  ) =>
    signInWithCredential(
      auth,
      GoogleAuthProvider.credential(
        JSON.stringify({ sub: email, email, name, email_verified: true })
      )
    );
}

export {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot
};