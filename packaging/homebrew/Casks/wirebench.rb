cask "wirebench" do
  arch arm: "arm64", intel: "x64"

  version "5.0.0"
  sha256 arm:   "6713097c7eb862a11c282c499000afcb4f611cf9bdbe2838038de1fcf50821a7",
         intel: "74bc30e317452f3737735d7d7feb4008b851ba405a52d3f7eb083e127707f480"

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
