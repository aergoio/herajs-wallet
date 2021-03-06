import { TypedEventEmitter } from '@elderapo/typed-event-emitter';
import { Wallet } from '../wallet';
import { Transaction, SignedTransaction } from '../models/transaction';
import { Key } from '../models/key';
import { Account } from '../models/account';
import { EncryptedIdSetting } from '../models/setting';
import {
    decryptPrivateKey,
    decodePrivateKey,
    encryptPrivateKey
} from '@herajs/crypto';
import { HashMap } from '../utils';

export interface Events {
    'add': Key;
    'update': Key;
    'change': Key[];
    'unlock': null;
    'lock': null;
}

interface ImportSpec {
    account: Account;
    b58encrypted?: string;
    password?: string;
    privateKey?: Buffer;
}

/**
 * KeyManager manages and tracks keys for accounts
 */
export default class KeyManager extends TypedEventEmitter<Events> {
    wallet: Wallet;
    keys: HashMap<string, Key> = new HashMap();
    masterPassphrase?: string;

    constructor(wallet: Wallet) {
        super();
        this.wallet = wallet;
    }

    addKey(account: Account, privateKey: Uint8Array | number[]): Key {
        const address = account.data.spec.address;
        
        const key = new Key(address, {
            privateKey: Array.from(privateKey),
            address,
            privateKeyEncrypted: null
        });
        this.keys.set(address, key);
        if (this.wallet.keystore) {
            if (!this.masterPassphrase) throw new Error('unlock wallet before adding key');
            const privateKeyEncrypted = encryptPrivateKey(Uint8Array.from(privateKey), this.masterPassphrase);
            key.data.privateKeyEncrypted = Array.from(privateKeyEncrypted);
            key.data.privateKey = null;
            this.wallet.keystore.getIndex('keys').put(key);
        }
        return key;
    }

    async getKey(account: Account): Promise<Key> {
        const address = account.data.spec.address;
        if (!this.keys.has(address) && this.wallet.keystore) {
            try {
                const keyRecord = await this.wallet.keystore.getIndex('keys').get(address);
                const key = Key.fromRecord(keyRecord);
                this.keys.set(address, key);
                return key;
            } catch (e) {
                throw new Error(`missing key for account ${address}`);
            }
        }
        return this.keys.get(address) as Key;
    }

    async getUnlockedKey(account: Account): Promise<Key> {
        const key = await this.getKey(account);
        key.unlock(this.masterPassphrase);
        return key;
    }

    async removeKey(address: string): Promise<void> {
        if (this.keys.has(address)) {
            this.keys.delete(address);
        }
        if (this.wallet.keystore) {
            await this.wallet.keystore.getIndex('keys').delete(address);
        }
    }

    async signTransaction(account: Account, transaction: Transaction): Promise<SignedTransaction> {
        const key = await this.getUnlockedKey(account);
        return key.signTransaction(transaction);
    }

    async signMessage(account: Account, message: Buffer, enc = 'hex'): Promise<string> {
        const key = await this.getUnlockedKey(account);
        return await key.signMessage(message, enc);
    }

    async importKey(importSpec: ImportSpec): Promise<Key> {
        let rawKey = new Uint8Array([]);
        if (typeof importSpec.b58encrypted === 'string' && typeof importSpec.password === 'string') {
            const encryptedKey = decodePrivateKey(importSpec.b58encrypted);
            rawKey = await decryptPrivateKey(encryptedKey, importSpec.password);
        }
        if (typeof importSpec.privateKey !== 'undefined') {
            rawKey = importSpec.privateKey;
        }
        if (!rawKey.length) throw new Error('no key provided. Supply b58encrypted and password or privateKey');
        return this.addKey(importSpec.account, rawKey);
    }

    /*
    import

    export
    */

    get unlocked(): boolean {
        return typeof this.masterPassphrase !== 'undefined'; 
    }

    async unlock (passphrase: string): Promise<void> {
        if (!this.wallet.datastore) throw new Error('configure storage before accessing keystore');
        const encryptedId = await this.wallet.datastore.getIndex('settings').get('encryptedId') as EncryptedIdSetting;
        try {
            await decryptPrivateKey(Uint8Array.from(encryptedId.data.value), passphrase);
        } catch (e) {
            throw new Error('invalid passphrase');
        }
        this.masterPassphrase = passphrase;
        this.emit('unlock', null);
    }

    async setupAndUnlock (appId: string, passphrase: string): Promise<void> {
        if (!this.wallet.datastore) throw new Error('configure storage before accessing keystore');
        // save extension id encrypted using password for a quick check if passphrase is correct later
        const encryptedId = new EncryptedIdSetting('encryptedId', {
            value: Array.from(await encryptPrivateKey(Buffer.from(appId), passphrase))
        });
        await this.wallet.datastore.getIndex('settings').put(encryptedId);
        await this.unlock(passphrase);
    }

    async clearKeys(): Promise<void> {
        this.keys.clear();
        if (this.wallet.keystore) {
            await this.wallet.keystore.getIndex('keys').clear();
        }
    }

    lock (): void {
        this.masterPassphrase = undefined;
        this.emit('lock', null);
    }
}