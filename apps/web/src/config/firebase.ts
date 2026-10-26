// cspell:disable
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyBBcb0DfpreeD4yyDsbTKIrEf4_dgDTixg',
  authDomain: 'push-that.firebaseapp.com',
  projectId: 'push-that',
  storageBucket: 'push-that.firebasestorage.app',
  messagingSenderId: '644804248017',
  appId: '1:644804248017:web:df4e171fa940c57dcae0f0',
  measurementId: 'G-R2M8XZZW7R',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
