import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// TODO: Replace this object with your actual keys from the Firebase browser tab!
const firebaseConfig = {
  apiKey: "AIzaSyDoACnoph1FKK8E7Aj5aQrtiMMfFzv1EKo",
  authDomain: "pacetrack-app.firebaseapp.com",
  projectId: "pacetrack-app",
  storageBucket: "pacetrack-app.firebasestorage.app",
  messagingSenderId: "475637796969",
  appId: "1:475637796969:web:9343589d4d22f48251d2f8"
};

// Initialize Firebase services
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);