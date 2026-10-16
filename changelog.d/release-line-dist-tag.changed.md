- Releases from the 0.21 line publish under the npm dist-tag `release-0.21`
  instead of `latest`, which stays on the newest line. 0.21.2 was tagged but
  never reached npm: the registry will not move `latest` back from 0.22.1
  implicitly. 0.21.3 carries the same code as the 0.21.2 tag, so it is the
  first 0.21 release that depends on `@animalabs/context-manager` `^0.15.0`.
  A semver range such as `^0.21.2` resolves to it without naming the tag.
