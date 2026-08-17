import os
import shutil
import base64
from PIL import Image

ARTIFACT_DIR = "/Users/george/.gemini/antigravity/brain/09f94d7f-cf49-4d96-9601-07f186cf434d"
THEMED_DIR = "assets/themed-t3trade"
BACKUP_DIR = "assets/original-backup"

PROD_ART_V2 = os.path.join(ARTIFACT_DIR, "t3trade_prod_v2_1786957946628.jpg")
DEV_ART_V2 = os.path.join(ARTIFACT_DIR, "t3trade_dev_v2_1786957882144.jpg")
NIGHTLY_ART_V2 = os.path.join(ARTIFACT_DIR, "t3trade_nightly_v2_1786957997079.jpg")
HERO_ART = os.path.join(ARTIFACT_DIR, "t3trade_hero_mission_1786906248151.jpg")

def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)

def apply_macos_squircle_mask(art_path, orig_mac_path, out_path, size=(1024, 1024)):
    ensure_dir(out_path)
    with Image.open(orig_mac_path) as orig_img:
        orig_img = orig_img.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
        orig_a = orig_img.split()[-1]
        
    with Image.open(art_path) as art_img:
        art_img = art_img.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
        art_r, art_g, art_b, _ = art_img.split()
        
        # Merge art RGB with original official macOS squircle alpha mask
        masked = Image.merge("RGBA", (art_r, art_g, art_b, orig_a))
        masked.save(out_path, format="PNG", optimize=True)
        print(f"Saved macOS Squircle Icon: {out_path} ({size[0]}x{size[1]})")

def save_image_sizes(src_path, target_paths_dict):
    with Image.open(src_path) as img:
        img_rgb = img.convert("RGBA")
        for target_path, (w, h, fmt) in target_paths_dict.items():
            ensure_dir(target_path)
            resized = img_rgb.resize((w, h), Image.Resampling.LANCZOS)
            if fmt.upper() == "ICO":
                sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
                icon_sizes = [s for s in sizes if s[0] <= w and s[1] <= h]
                if not icon_sizes:
                    icon_sizes = [(w, h)]
                resized.save(target_path, format="ICO", sizes=icon_sizes)
            elif fmt.upper() == "WEBP":
                resized.save(target_path, format="WEBP", quality=95)
            elif fmt.upper() == "PNG":
                resized.save(target_path, format="PNG", optimize=True)
            elif fmt.upper() in ("JPG", "JPEG"):
                resized.convert("RGB").save(target_path, format="JPEG", quality=95)
            print(f"Saved: {target_path} ({w}x{h} {fmt})")

def build_harness_svgs():
    harness_dir = f"{THEMED_DIR}/apps/marketing/public/harnesses"
    os.makedirs(harness_dir, exist_ok=True)
    
    # 1. Claude AI (Exact official vector geometry in T3 Trade emerald)
    claude_svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="256" height="257" preserveAspectRatio="xMidYMid" viewBox="0 0 256 257"><path fill="#10b981" d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"></path></svg>'''
    with open(f"{harness_dir}/claude-ai-icon.svg", "w") as f:
        f.write(claude_svg)

    # 2. OpenAI Codex (Exact official vector geometry in T3 Trade emerald)
    openai_svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="256" height="260" preserveAspectRatio="xMidYMid" viewBox="0 0 256 260"><path fill="#10b981" d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"></path></svg>'''
    with open(f"{harness_dir}/openai_dark.svg", "w") as f:
        f.write(openai_svg)

    # 3. Cursor (Exact official vector geometry in T3 Trade emerald)
    cursor_svg = '''<?xml version="1.0" encoding="UTF-8"?><svg id="cursor_light__Ebene_1" xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 466.73 532.09"><path class="cursor_light__st0" fill="#10b981" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"></path></svg>'''
    with open(f"{harness_dir}/cursor_light.svg", "w") as f:
        f.write(cursor_svg)

    # 4. Grok (Exact official vector geometry in T3 Trade emerald & mint)
    grok_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <path fill="#10b981" d="M9.26905 15.284L17.2479 9.36086C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349C15.0238 18.7976 12.3082 19.228 9.8261 18.2477L7.1146 19.5102C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525C21.0182 16.1985 21.7432 12.9897 21.0653 10.0961L21.0714 10.1023C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913C23.8812 0.595532 23.9406 0.513151 24 0.428711L20.6987 3.74866V3.73836L9.267 15.2861" />
  <path fill="#34d399" d="M7.62249 16.7237C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905C9.45541 5.72786 12.341 5.00497 14.86 6.06768L17.5653 4.81138C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839C12.4966 2.46764 8.6178 3.13492 5.98413 5.78141C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889C5.04412 18.0871 3.36889 19.8541 1.68137 21.6377C1.08337 22.2699 0.483318 22.9022 0 23.5716L7.62045 16.7257" />
</svg>'''
    with open(f"{harness_dir}/grok-dark.svg", "w") as f:
        f.write(grok_svg)

    # 5. OpenCode (Exact official vector geometry in T3 Trade palette)
    opencode_svg = '''<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="512" height="512" viewBox="0 0 512 512" fill="none"><rect width="512" height="512" rx="64" fill="#09090b"></rect><path d="M320 224V352H192V224H320Z" fill="#0f766e"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#10b981"></path></svg>'''
    with open(f"{harness_dir}/opencode-dark.svg", "w") as f:
        f.write(opencode_svg)

    print("Saved clean authentic Harness SVGs in T3 Trade palette.")

def build_vector_brand_svgs():
    logo_svg = '''<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M0 10C0 4.47715 4.47715 0 10 0H118C123.523 0 128 4.47715 128 10V118C128 123.523 123.523 128 118 128H10C4.47715 128 0 123.523 0 118V10Z" fill="#09090b"/>
<path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z" fill="#10b981"/>
</svg>'''
    ensure_dir(f"{THEMED_DIR}/assets/prod/logo.svg")
    with open(f"{THEMED_DIR}/assets/prod/logo.svg", "w") as f:
        f.write(logo_svg)
    ensure_dir(f"{THEMED_DIR}/assets/prod/app-icon.icon/Assets/text.svg")
    with open(f"{THEMED_DIR}/assets/prod/app-icon.icon/Assets/text.svg", "w") as f:
        f.write(logo_svg)

    t3mark_svg = '''<svg width="111" height="74" viewBox="7 29 111 74" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z" fill="#10b981"/>
</svg>'''
    ensure_dir(f"{THEMED_DIR}/apps/mobile/assets/widget/T3Mark.svg")
    with open(f"{THEMED_DIR}/apps/mobile/assets/widget/T3Mark.svg", "w") as f:
        f.write(t3mark_svg)

    for svg_name in ["annotations.svg", "background.svg", "text.svg"]:
        orig_p = f"{BACKUP_DIR}/assets/dev/app-icon.icon/Assets/{svg_name}"
        dest_p = f"{THEMED_DIR}/assets/dev/app-icon.icon/Assets/{svg_name}"
        if os.path.exists(orig_p):
            ensure_dir(dest_p)
            shutil.copyfile(orig_p, dest_p)

    for svg_name in ["background.svg", "cloud-lower-left.svg", "cloud-upper-right.svg", "text.svg"]:
        orig_p = f"{BACKUP_DIR}/assets/nightly/app-icon.icon/Assets/{svg_name}"
        dest_p = f"{THEMED_DIR}/assets/nightly/app-icon.icon/Assets/{svg_name}"
        if os.path.exists(orig_p):
            ensure_dir(dest_p)
            shutil.copyfile(orig_p, dest_p)

def build_file_icons():
    src_dir = f"{BACKUP_DIR}/apps/mobile/modules/t3-markdown-text/assets/file-icons"
    out_dir = f"{THEMED_DIR}/apps/mobile/modules/t3-markdown-text/assets/file-icons"
    os.makedirs(out_dir, exist_ok=True)
    
    for filename in sorted(os.listdir(src_dir)):
        if not filename.endswith(".png"):
            continue
        orig_path = os.path.join(src_dir, filename)
        out_path = os.path.join(out_dir, filename)
        
        with Image.open(orig_path) as orig_icon:
            orig_icon = orig_icon.convert("RGBA")
            r, g, b, a = orig_icon.split()
            
            enhanced_r = r.point(lambda i: int(i * 0.8))
            enhanced_g = g.point(lambda i: min(255, int(i * 1.2 + 25)))
            enhanced_b = b.point(lambda i: min(255, int(i * 1.1 + 15)))
            tinted = Image.merge("RGBA", (enhanced_r, enhanced_g, enhanced_b, a))
            tinted.save(out_path, format="PNG", optimize=True)

def main():
    print("Rebuilding T3 Trade Theme Assets v2 (Safe Area & Perfect Squircle Geometry)...")
    
    # 1. Production Brand Assets
    apply_macos_squircle_mask(PROD_ART_V2, f"{BACKUP_DIR}/assets/prod/black-macos-1024.png", f"{THEMED_DIR}/assets/prod/black-macos-1024.png")
    apply_macos_squircle_mask(PROD_ART_V2, f"{BACKUP_DIR}/assets/prod/black-macos-1024.png", f"{THEMED_DIR}/apps/marketing/public/icon.png")
    apply_macos_squircle_mask(PROD_ART_V2, f"{BACKUP_DIR}/assets/prod/black-macos-1024.png", f"{THEMED_DIR}/apps/marketing/public/icon.webp")
    apply_macos_squircle_mask(PROD_ART_V2, f"{BACKUP_DIR}/assets/prod/black-macos-1024.png", f"{THEMED_DIR}/apps/desktop/resources/icon.png", size=(512, 512))
    
    prod_targets = {
        f"{THEMED_DIR}/assets/prod/black-universal-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/prod/black-ios-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/prod/t3-black-web-apple-touch-180.png": (180, 180, "PNG"),
        f"{THEMED_DIR}/assets/prod/t3-black-web-favicon-32x32.png": (32, 32, "PNG"),
        f"{THEMED_DIR}/assets/prod/t3-black-web-favicon-16x16.png": (16, 16, "PNG"),
        f"{THEMED_DIR}/assets/prod/t3-black-web-favicon.ico": (256, 256, "ICO"),
        f"{THEMED_DIR}/assets/prod/t3-black-windows.ico": (256, 256, "ICO"),
        
        f"{THEMED_DIR}/apps/web/public/apple-touch-icon.png": (180, 180, "PNG"),
        f"{THEMED_DIR}/apps/web/public/favicon-32x32.png": (32, 32, "PNG"),
        f"{THEMED_DIR}/apps/web/public/favicon-16x16.png": (16, 16, "PNG"),
        f"{THEMED_DIR}/apps/web/public/favicon.ico": (256, 256, "ICO"),
        
        f"{THEMED_DIR}/apps/desktop/resources/icon.ico": (256, 256, "ICO"),
        
        f"{THEMED_DIR}/apps/mobile/assets/android-icon-mark.png": (432, 432, "PNG"),
        f"{THEMED_DIR}/apps/mobile/assets/android-notification-icon.png": (96, 96, "PNG"),
        
        f"{THEMED_DIR}/apps/marketing/public/apple-touch-icon.png": (180, 180, "PNG"),
        f"{THEMED_DIR}/apps/marketing/public/apple-touch-icon.webp": (180, 180, "WEBP"),
        f"{THEMED_DIR}/apps/marketing/public/favicon-32x32.png": (32, 32, "PNG"),
        f"{THEMED_DIR}/apps/marketing/public/favicon-32x32.webp": (32, 32, "WEBP"),
        f"{THEMED_DIR}/apps/marketing/public/favicon-16x16.png": (16, 16, "PNG"),
        f"{THEMED_DIR}/apps/marketing/public/favicon-16x16.webp": (16, 16, "WEBP"),
        f"{THEMED_DIR}/apps/marketing/public/favicon.ico": (256, 256, "ICO"),
    }
    save_image_sizes(PROD_ART_V2, prod_targets)

    # 2. Development Blueprint Assets (macOS squircle mask applied with safe interior)
    apply_macos_squircle_mask(DEV_ART_V2, f"{BACKUP_DIR}/assets/dev/blueprint-macos-1024.png", f"{THEMED_DIR}/assets/dev/blueprint-macos-1024.png")
    
    dev_targets = {
        f"{THEMED_DIR}/assets/dev/blueprint-universal-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/dev/blueprint-ios-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/dev/blueprint-web-apple-touch-180.png": (180, 180, "PNG"),
        f"{THEMED_DIR}/assets/dev/blueprint-web-favicon-32x32.png": (32, 32, "PNG"),
        f"{THEMED_DIR}/assets/dev/blueprint-web-favicon-16x16.png": (16, 16, "PNG"),
        f"{THEMED_DIR}/assets/dev/blueprint-web-favicon.ico": (256, 256, "ICO"),
        f"{THEMED_DIR}/assets/dev/blueprint-windows.ico": (256, 256, "ICO"),
    }
    save_image_sizes(DEV_ART_V2, dev_targets)

    # 3. Nightly Nebula Assets
    apply_macos_squircle_mask(NIGHTLY_ART_V2, f"{BACKUP_DIR}/assets/nightly/nightly-macos-1024.png", f"{THEMED_DIR}/assets/nightly/nightly-macos-1024.png")
    
    nightly_targets = {
        f"{THEMED_DIR}/assets/nightly/nightly-universal-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/nightly/nightly-ios-1024.png": (1024, 1024, "PNG"),
        f"{THEMED_DIR}/assets/nightly/nightly-web-apple-touch-180.png": (180, 180, "PNG"),
        f"{THEMED_DIR}/assets/nightly/nightly-web-favicon-32x32.png": (32, 32, "PNG"),
        f"{THEMED_DIR}/assets/nightly/nightly-web-favicon-16x16.png": (16, 16, "PNG"),
        f"{THEMED_DIR}/assets/nightly/nightly-web-favicon.ico": (256, 256, "ICO"),
        f"{THEMED_DIR}/assets/nightly/nightly-windows.ico": (256, 256, "ICO"),
    }
    save_image_sizes(NIGHTLY_ART_V2, nightly_targets)

    # 4. Hero Screenshots & Media
    hero_targets = {
        f"{THEMED_DIR}/apps/marketing/public/t3trade-screenshot.webp": (2400, 1535, "WEBP"),
        f"{THEMED_DIR}/docs/media/t3trade-mission.png": (1840, 1177, "PNG"),
    }
    save_image_sizes(HERO_ART, hero_targets)

    # 5. Marketing Harness SVGs
    build_harness_svgs()

    # 6. Brand SVGs
    build_vector_brand_svgs()

    # 7. File Icons
    build_file_icons()

    print("\n✅ All T3 Trade themed assets rebuilt v2 successfully with safe interior margins and authentic macOS squircle geometry!")

if __name__ == "__main__":
    main()
