One-time production Worker deployment trigger.

Validated source tree: `cbd851eca419f93670619fd421a1dd8b0fbceffc`.
Merged release commit: `8c66ae319f0c892e7794a5d9c19be673d070b7b0`.

This trigger deploys only the Telegram sales Worker. It does not enable Vision on any node and does not modify any EC2 instance.

The guarded deployment workflow is now installed on the repository default branch. This commit re-arms the one-time deployment after all release checks passed.
