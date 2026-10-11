import UIKit

// A favorite's details over a dimmed screen: its titles (Japanese first), artists, groups,
// type, language, pages, source, what is saved on the phone and its tags. A tap outside or
// Close dismisses it.
@MainActor
final class InfoSheet: UIViewController {
    private let app: AppController
    private let item: GalleryItem
    private var details: GalleryManifest?
    private let card = UIView()
    private let scroll = UIScrollView()
    private let stack = UIStackView()

    init(app: AppController, item: GalleryItem, details: GalleryManifest?) {
        self.app = app
        self.item = item
        self.details = details
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0, alpha: 0.85)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backgroundTapped(_:))))
        card.backgroundColor = UIColor(white: 0.118, alpha: 1)
        card.layer.cornerRadius = 12
        card.layer.borderWidth = 1
        card.layer.borderColor = UIColor(white: 0.2, alpha: 1).cgColor
        view.addSubview(card)
        stack.axis = .vertical
        stack.spacing = 12
        scroll.addSubview(stack)
        card.addSubview(scroll)
        var close = UIButton.Configuration.filled()
        close.title = "Close"
        close.baseBackgroundColor = UIColor(white: 0.2, alpha: 1)
        close.baseForegroundColor = UIColor(white: 0.93, alpha: 1)
        let closeButton = UIButton(configuration: close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        closeButton.tag = 1
        card.addSubview(closeButton)
        build()
        if details == nil {
            Task { [weak self, app, item] in
                let gallery = try? await app.gallery(item.key)
                guard let self else { return }
                details = gallery?.manifest
                build()
                view.setNeedsLayout()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = min(view.bounds.width * 0.9, 500)
        let inner = width - 48
        let size = stack.systemLayoutSizeFitting(CGSize(width: inner, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let maxHeight = view.bounds.height * 0.85
        let height = min(size.height + 24 + 44 + 20 + 24, maxHeight)
        card.frame = CGRect(x: (view.bounds.width - width) / 2, y: (view.bounds.height - height) / 2, width: width, height: height)
        scroll.frame = CGRect(x: 24, y: 24, width: inner, height: height - 24 - 44 - 20 - 24)
        stack.frame = CGRect(x: 0, y: 0, width: inner, height: size.height)
        scroll.contentSize = stack.frame.size
        if let close = card.viewWithTag(1) {
            let closeSize = close.intrinsicContentSize
            close.frame = CGRect(x: width - 24 - max(closeSize.width, 88), y: height - 24 - 44, width: max(closeSize.width, 88), height: 44)
        }
    }

    @objc private func backgroundTapped(_ tap: UITapGestureRecognizer) {
        if !card.frame.contains(tap.location(in: view)) { dismiss(animated: true) }
    }

    private func build() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.addArrangedSubview(title(item.title, size: 19))
        guard let manifest = details else {
            stack.addArrangedSubview(row("Status", "Loading…"))
            return
        }
        let meta = manifest.metadata
        if let other = meta?.title, other != item.title { stack.addArrangedSubview(title(other, size: 19)) }
        for (label, values) in [("Artist", meta?.artists), ("Group", meta?.groups)] {
            if let values, !values.isEmpty { stack.addArrangedSubview(row(label, values.joined(separator: ", "))) }
        }
        for (label, value) in [("Type", meta?.type), ("Language", meta?.language)] {
            if let value, !value.isEmpty { stack.addArrangedSubview(row(label, value)) }
        }
        stack.addArrangedSubview(row("Pages", String(manifest.pages.count)))
        stack.addArrangedSubview(row("Source", item.key))
        let saved = app.library.originals[item.key]?.downloaded ?? 0, thumbs = app.library.thumbnails[item.key]?.downloaded ?? 0
        stack.addArrangedSubview(row("Device", "\(saved)/\(manifest.pages.count) pages · \(thumbs) thumbnails"))
        if let tags = meta?.tags, !tags.isEmpty { stack.addArrangedSubview(TagCloud(tags)) }
    }

    private func title(_ text: String, size: CGFloat) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .boldSystemFont(ofSize: size)
        label.textColor = UIColor(white: 0.93, alpha: 1)
        label.numberOfLines = 0
        return label
    }

    private func row(_ label: String, _ value: String) -> UIView {
        let key = UILabel(), text = UILabel()
        key.text = label
        key.textColor = UIColor(white: 0.53, alpha: 1)
        key.font = .systemFont(ofSize: 15)
        key.widthAnchor.constraint(equalToConstant: 80).isActive = true
        key.setContentHuggingPriority(.required, for: .horizontal)
        text.text = value
        text.textColor = UIColor(white: 0.93, alpha: 1)
        text.font = .systemFont(ofSize: 15)
        text.numberOfLines = 0
        let line = UIStackView(arrangedSubviews: [key, text])
        line.spacing = 8
        line.alignment = .top
        return line
    }
}

// Tag chips wrapping onto as many lines as they need.
@MainActor
final class TagCloud: UIView {
    private let chips: [UILabel]

    init(_ tags: [String]) {
        chips = tags.map { tag in
            let label = PaddedLabel()
            label.text = tag
            label.font = .systemFont(ofSize: 14)
            label.textColor = UIColor(white: 0.87, alpha: 1)
            label.backgroundColor = UIColor(white: 0.2, alpha: 1)
            label.layer.cornerRadius = 4
            label.clipsToBounds = true
            return label
        }
        super.init(frame: .zero)
        chips.forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func layoutSubviews() {
        super.layoutSubviews()
        _ = arrange(width: bounds.width, apply: true)
    }

    override func systemLayoutSizeFitting(_ target: CGSize, withHorizontalFittingPriority horizontal: UILayoutPriority,
                                          verticalFittingPriority vertical: UILayoutPriority) -> CGSize {
        CGSize(width: target.width, height: arrange(width: target.width, apply: false))
    }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: arrange(width: bounds.width > 0 ? bounds.width : 300, apply: false)) }

    private func arrange(width: CGFloat, apply: Bool) -> CGFloat {
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for chip in chips {
            let size = chip.intrinsicContentSize
            if x + size.width > width, x > 0 { x = 0; y += rowHeight + 6; rowHeight = 0 }
            if apply { chip.frame = CGRect(x: x, y: y, width: min(size.width, width), height: size.height) }
            x += size.width + 6
            rowHeight = max(rowHeight, size.height)
        }
        return y + rowHeight
    }
}

final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 8, dy: 4)) }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 16, height: size.height + 8)
    }
}
