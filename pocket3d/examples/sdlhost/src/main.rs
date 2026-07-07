//! sdlhost — PocketJS UI demos in an SDL2 software-rendered window.
//!
//!   cargo run -p sdlhost -- --app hero-main
//!   cargo run -p sdlhost -- --app music --scale 3 --auto-quit 5
//!
//! Build bundles first from the repo root, for example:
//!
//!   bun scripts/build.ts hero-main

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use pocket_mod::Guest;
use pocket_mod::qjs::Function;
use pocket_ui_wgpu::UiSurface;
use sdl2::event::Event;
use sdl2::keyboard::Keycode;
use sdl2::mouse::MouseButton;
use sdl2::pixels::PixelFormatEnum;

const UI_W: u32 = 480;
const UI_H: u32 = 272;
const FRAME: Duration = Duration::from_nanos(1_000_000_000 / 60);

const BTN_SELECT: u32 = 0x0001;
const BTN_START: u32 = 0x0008;
const BTN_UP: u32 = 0x0010;
const BTN_RIGHT: u32 = 0x0020;
const BTN_DOWN: u32 = 0x0040;
const BTN_LEFT: u32 = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_TRIANGLE: u32 = 0x1000;
const BTN_CIRCLE: u32 = 0x2000;
const BTN_CROSS: u32 = 0x4000;
const BTN_SQUARE: u32 = 0x8000;
const POINTER_PRIMARY: u32 = 0x01;

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    scale: u32,
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "hero-main".into(),
        js: None,
        pak: None,
        scale: 2,
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--scale" => args.scale = val("--scale")?.parse::<u32>()?.clamp(1, 8),
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn dist_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("POCKETJS_DIST") {
        return Some(PathBuf::from(d));
    }
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dist")
        .canonicalize()
        .ok();
    from_manifest.or_else(|| {
        let cwd = PathBuf::from("dist");
        cwd.is_dir().then_some(cwd)
    })
}

fn resolve_asset(explicit: Option<PathBuf>, app: &str, ext: &str) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return p
            .canonicalize()
            .with_context(|| format!("missing {}", p.display()));
    }
    let dist =
        dist_dir().ok_or_else(|| anyhow!("cannot find PocketJS dist/ (set POCKETJS_DIST)"))?;
    for c in [format!("{app}.{ext}"), format!("{app}-main.{ext}")] {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} - build it first: bun scripts/build.ts {app}",
        dist.display()
    ))
}

fn resolve_optional_pak(args: &Args) -> Result<Option<PathBuf>> {
    if args.pak.is_some() {
        return resolve_asset(args.pak.clone(), &args.app, "pak").map(Some);
    }
    if args.js.is_some() {
        return Ok(None);
    }
    resolve_asset(None, &args.app, "pak").map(Some)
}

fn boot(args: &Args) -> Result<(Guest, UiSurface)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_optional_pak(args)?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;

    let surface = UiSurface::new((UI_W as f32, UI_H as f32));
    let pak_len = if let Some(pak_path) = pak_path {
        let pak =
            std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;
        let len = pak.len();
        surface.feed_pak(&pak);
        len
    } else {
        log::warn!("sdlhost: no pak loaded; explicit --js smoke runs must use raw ui.* ops only");
        0
    };
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval(&args.app, &bundle)?;
    if !guest.has_frame() {
        return Err(anyhow!(
            "bundle evaluated but installed no frame() - is this a PocketJS app?"
        ));
    }
    log::info!(
        "sdlhost: booted {} ({} bytes js, {} bytes pak)",
        args.app,
        bundle.len(),
        pak_len
    );
    Ok((guest, surface))
}

fn button_for(key: Keycode) -> Option<u32> {
    Some(match key {
        Keycode::Up => BTN_UP,
        Keycode::Down => BTN_DOWN,
        Keycode::Left => BTN_LEFT,
        Keycode::Right => BTN_RIGHT,
        Keycode::Z | Keycode::Return => BTN_CROSS,
        Keycode::X | Keycode::Backspace => BTN_CIRCLE,
        Keycode::A => BTN_SQUARE,
        Keycode::S => BTN_TRIANGLE,
        Keycode::Q => BTN_LTRIGGER,
        Keycode::W => BTN_RTRIGGER,
        Keycode::Tab => BTN_SELECT,
        Keycode::Space => BTN_START,
        _ => return None,
    })
}

fn event_to_ui(x: i32, y: i32) -> (f64, f64) {
    // set_logical_size() makes SDL mouse events arrive in the same logical
    // coordinate space that the renderer presents, so no window-scale math is
    // needed here.
    (x as f64, y as f64)
}

fn dispatch_pointer(
    guest: &Guest,
    source: &str,
    phase: &str,
    id: i32,
    x: f64,
    y: f64,
    button: i32,
    buttons: u32,
) -> Result<()> {
    guest.with(|ctx| -> Result<()> {
        let pointer: Option<Function> = ctx.globals().get("__pocketjsPointer").ok();
        if let Some(pointer) = pointer {
            pointer.call::<_, ()>((source, phase, id, x, y, button, buttons))?;
        }
        Ok(())
    })
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let (guest, surface) = boot(&args)?;

    let sdl = sdl2::init().map_err(|e| anyhow!("sdl init: {e}"))?;
    let video = sdl.video().map_err(|e| anyhow!("sdl video: {e}"))?;
    let window = video
        .window("PocketJS SDL2", UI_W * args.scale, UI_H * args.scale)
        .position_centered()
        .allow_highdpi()
        .build()
        .map_err(|e| anyhow!("sdl window: {e}"))?;
    let mut canvas = window
        .into_canvas()
        .accelerated()
        .present_vsync()
        .build()
        .map_err(|e| anyhow!("sdl canvas: {e}"))?;
    canvas
        .set_logical_size(UI_W, UI_H)
        .map_err(|e| anyhow!("sdl logical size: {e}"))?;
    let creator = canvas.texture_creator();
    let mut texture = creator
        .create_texture_streaming(PixelFormatEnum::ABGR8888, UI_W, UI_H)
        .map_err(|e| anyhow!("sdl texture: {e}"))?;
    let mut events = sdl.event_pump().map_err(|e| anyhow!("sdl events: {e}"))?;
    let mut framebuffer = vec![0u8; (UI_W * UI_H * 4) as usize];
    let mut buttons = 0u32;
    let mut pointer_buttons = 0u32;
    let started = Instant::now();
    let mut next_frame = Instant::now();

    'running: loop {
        for event in events.poll_iter() {
            match event {
                Event::Quit { .. } => break 'running,
                Event::KeyDown {
                    keycode: Some(Keycode::Escape),
                    ..
                } => break 'running,
                Event::KeyDown {
                    keycode: Some(key),
                    repeat: false,
                    ..
                } => {
                    if let Some(bit) = button_for(key) {
                        buttons |= bit;
                    }
                }
                Event::KeyUp {
                    keycode: Some(key),
                    repeat: false,
                    ..
                } => {
                    if let Some(bit) = button_for(key) {
                        buttons &= !bit;
                    }
                }
                Event::MouseButtonDown {
                    mouse_btn: MouseButton::Left,
                    x,
                    y,
                    ..
                } => {
                    pointer_buttons |= POINTER_PRIMARY;
                    let (ux, uy) = event_to_ui(x, y);
                    dispatch_pointer(&guest, "mouse", "down", 0, ux, uy, 0, pointer_buttons)?;
                }
                Event::MouseMotion { x, y, .. } => {
                    let (ux, uy) = event_to_ui(x, y);
                    dispatch_pointer(&guest, "mouse", "move", 0, ux, uy, 0, pointer_buttons)?;
                }
                Event::MouseButtonUp {
                    mouse_btn: MouseButton::Left,
                    x,
                    y,
                    ..
                } => {
                    pointer_buttons &= !POINTER_PRIMARY;
                    let (ux, uy) = event_to_ui(x, y);
                    dispatch_pointer(&guest, "mouse", "up", 0, ux, uy, 0, pointer_buttons)?;
                }
                _ => {}
            }
        }

        if let Some(limit) = args.auto_quit
            && started.elapsed().as_secs_f32() > limit
        {
            break 'running;
        }

        guest.frame(buttons)?;
        surface.tick();
        surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            pocket_ui_soft::render(ui, &words, &mut framebuffer);
        });
        texture
            .update(None, &framebuffer, (UI_W * 4) as usize)
            .map_err(|e| anyhow!("sdl texture update: {e}"))?;
        canvas.clear();
        canvas
            .copy(&texture, None, None)
            .map_err(|e| anyhow!("sdl copy: {e}"))?;
        canvas.present();

        next_frame += FRAME;
        let now = Instant::now();
        if next_frame > now {
            std::thread::sleep(next_frame - now);
        } else {
            next_frame = now;
        }
    }

    Ok(())
}
