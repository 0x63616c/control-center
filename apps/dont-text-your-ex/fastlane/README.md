fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios setup_ios

```sh
[bundle exec] fastlane ios setup_ios
```

Register a new app + mint its profile against the shared match repo

### ios enable_apple_sign_in

```sh
[bundle exec] fastlane ios enable_apple_sign_in
```

Enable Sign In with Apple on the App ID + refresh the profile

### ios setup_testflight

```sh
[bundle exec] fastlane ios setup_testflight
```

Create an internal TestFlight group + add the account holder as a tester

### ios release

```sh
[bundle exec] fastlane ios release
```

Build and upload to TestFlight

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
