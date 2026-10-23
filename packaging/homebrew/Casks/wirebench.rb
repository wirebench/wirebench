cask "wirebench" do
  arch arm: "arm64", intel: "x64"

  version "6.1.0"
  sha256 arm:   "7302350a9672ce3c67bf2ad4274bc043d3da077d813a7e1ea1ee01d2eefc4e61",
         intel: "0c35f36f9c44e75b2e64e2dce54f72fdfad83bc27d58ded8e3eb7957f95e87fa"

  url "https://github.com/wirebench/wirebench/releases/download/v#{version}/Wirebench-#{version}-mac-#{arch}.dmg"
  name "Wirebench"
  desc "Local-first API and SSH workbench"
  homepage "https://wirebench.github.io/wirebench/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "Wirebench.app"

  zap trash: [
    "~/Library/Application Support/Wirebench",
    "~/Library/Caches/io.wirebench.desktop",
    "~/Library/Caches/io.wirebench.desktop.ShipIt",
    "~/Library/HTTPStorages/io.wirebench.desktop",
    "~/Library/Logs/Wirebench",
    "~/Library/Preferences/io.wirebench.desktop.plist",
    "~/Library/Saved Application State/io.wirebench.desktop.savedState",
  ]
end
