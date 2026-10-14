# SAML test identity provider keys

Self-signed RSA 2048 keys and certificates for the SAML sign-in tests (saml-scim plan ruling 9), made
once with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout idp-key.pem -out idp-cert.pem -days 36500 \
  -subj "/CN=wirebench-test-idp-saml-signing"
```

`idp-*` is the identity provider the test server trusts; `other-*` is a key it does not. They are test
material only: they sign nothing outside `test/helpers/saml-idp.ts`, and no server configuration
should ever name them.
