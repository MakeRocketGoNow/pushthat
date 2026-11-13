import { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';

/**
 * The marker a deleted account leaves until its second purge (account-deletion.ts): two
 * times and nothing else, at `accountDeletions/{uid}`.
 *
 * In a file of its own because two files need it and one of them imports the other:
 * account-deletion.ts writes and sweeps the markers, and `createCheckoutSession` in
 * stripe-functions.ts refuses an account that has one. With the collection's name written
 * out in both, renaming it in one would have quietly let a deleted account's last token
 * open a checkout again.
 */
export const deletionMarkers = (db: Firestore): CollectionReference => db.collection('accountDeletions');

export const deletionRef = (db: Firestore, uid: string): DocumentReference => deletionMarkers(db).doc(uid);
