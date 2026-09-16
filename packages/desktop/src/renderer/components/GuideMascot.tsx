import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motionDuration, motionEase } from '@/styles/design-tokens';

export type GuideMascotPose = 'idle' | 'phone' | 'covering' | 'success';

interface GuideMascotProps {
  pose: GuideMascotPose;
  trackPointer?: boolean;
  className?: string;
  label?: string;
}

const ARM_MOTION = { duration: motionDuration.moderate, ease: motionEase.standard };

export default function GuideMascot({
  pose,
  trackPointer = true,
  className,
  label = '荣盈魔方引导助手',
}: GuideMascotProps) {
  const reduceMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const covering = pose === 'covering';

  useEffect(() => {
    if (!trackPointer || reduceMotion || covering) {
      setLook({ x: 0, y: 0 });
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const bounds = svgRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const dx = event.clientX - (bounds.left + bounds.width / 2);
      const dy = event.clientY - (bounds.top + bounds.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const strength = Math.min(5, distance / 42);
      setLook({ x: (dx / distance) * strength, y: (dy / distance) * strength });
    };

    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [covering, reduceMotion, trackPointer]);

  const leftArm = covering ? 'M112 191 C110 164 121 148 139 143' : 'M112 191 C78 198 68 229 91 244';
  const rightArm = covering ? 'M248 191 C250 164 239 148 221 143' : 'M248 191 C282 198 292 229 269 244';
  const leftHand = covering ? { cx: 140, cy: 143, r: 22 } : { cx: 91, cy: 244, r: 14 };
  const rightHand = covering ? { cx: 220, cy: 143, r: 22 } : { cx: 269, cy: 244, r: 14 };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 360 290"
      role="img"
      aria-label={label}
      data-pose={pose}
      className={cn('h-auto w-full overflow-visible', className)}
    >
      <defs>
        <linearGradient id="guide-body" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--accent)" />
          <stop offset="0.52" stopColor="var(--accent-hover)" />
          <stop offset="1" stopColor="var(--danger)" />
        </linearGradient>
        <linearGradient id="guide-hand" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--warning)" />
          <stop offset="1" stopColor="var(--danger)" />
        </linearGradient>
        <filter id="guide-shadow" x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="12" stdDeviation="10" floodColor="var(--text-secondary)" floodOpacity="0.18" />
        </filter>
      </defs>

      <ellipse cx="180" cy="263" rx="92" ry="13" fill="var(--accent-dim)" />
      <motion.g
        filter="url(#guide-shadow)"
        animate={reduceMotion ? undefined : pose === 'success' ? { y: [0, -7, 0] } : { y: 0 }}
        transition={{ duration: motionDuration.slow, ease: motionEase.standard }}
      >
        <rect x="104" y="67" width="152" height="168" rx="46" fill="url(#guide-body)" />
        <path d="M104 118 180 70l76 48-76 49Z" fill="var(--glass-highlight)" />
        <path d="M180 70v97" fill="none" stroke="var(--border)" strokeWidth="2" />
        <path d="M104 118l76 49 76-49" fill="none" stroke="var(--border-accent)" strokeWidth="2" />

        <g opacity={covering ? 0.28 : 1}>
          <ellipse cx="144" cy="142" rx="19" ry="23" fill="var(--surface-qr-bg)" />
          <ellipse cx="216" cy="142" rx="19" ry="23" fill="var(--surface-qr-bg)" />
          <motion.circle
            cx="144"
            cy="143"
            r="8"
            fill="var(--accent-foreground)"
            animate={{ x: look.x, y: look.y }}
            transition={{ duration: motionDuration.fast, ease: motionEase.standard }}
          />
          <motion.circle
            cx="216"
            cy="143"
            r="8"
            fill="var(--accent-foreground)"
            animate={{ x: look.x, y: look.y }}
            transition={{ duration: motionDuration.fast, ease: motionEase.standard }}
          />
          <circle cx={141 + look.x} cy={139 + look.y} r="2.5" fill="var(--surface-qr-bg)" />
          <circle cx={213 + look.x} cy={139 + look.y} r="2.5" fill="var(--surface-qr-bg)" />
        </g>

        <motion.path
          d={pose === 'success' ? 'M166 185 Q180 197 194 185' : 'M169 185 Q180 191 191 185'}
          fill="none"
          stroke="var(--surface-qr-bg)"
          strokeWidth="4"
          strokeLinecap="round"
        />

        <g data-arm="left" data-pose={pose}>
          <motion.path
            animate={{ d: leftArm }}
            initial={false}
            transition={ARM_MOTION}
            fill="none"
            stroke="var(--text-onboarding-muted)"
            strokeWidth="17"
            strokeLinecap="round"
          />
          <motion.circle animate={leftHand} initial={false} transition={ARM_MOTION} fill="url(#guide-hand)" />
        </g>
        <g data-arm="right" data-pose={pose}>
          <motion.path
            animate={{ d: rightArm }}
            initial={false}
            transition={ARM_MOTION}
            fill="none"
            stroke="var(--text-onboarding-muted)"
            strokeWidth="17"
            strokeLinecap="round"
          />
          <motion.circle animate={rightHand} initial={false} transition={ARM_MOTION} fill="url(#guide-hand)" />
        </g>
      </motion.g>
    </svg>
  );
}
