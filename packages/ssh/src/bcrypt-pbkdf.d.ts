// bcrypt-pbkdf ships no types; this is the one function the sk key format reads (ssh2 depends on the same package).
declare module 'bcrypt-pbkdf' {
  const bcrypt: {
    pbkdf(
      pass: Uint8Array,
      passlen: number,
      salt: Uint8Array,
      saltlen: number,
      key: Uint8Array,
      keylen: number,
      rounds: number,
    ): number;
  };
  export default bcrypt;
}
