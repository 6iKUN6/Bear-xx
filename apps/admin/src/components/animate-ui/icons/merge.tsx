'use client';

import { motion, type Variants } from 'motion/react';

import {
  getVariants,
  useAnimateIconContext,
  IconWrapper,
  type IconProps,
} from '@/components/animate-ui/icons/icon';

type MergeProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    group: {
      initial: {
        scale: 1,
        transition: { type: 'spring', stiffness: 150, damping: 25 },
      },
      animate: {
        scale: 1,
        transition: { type: 'spring', stiffness: 150, damping: 25 },
      },
    },
    path1: {},
    path2: {},
    path3: {},
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: MergeProps) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(animations);

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="m8 6 4-4 4 4"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="m20 22-5-5"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}

function Merge(props: MergeProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  Merge,
  Merge as MergeIcon,
  type MergeProps,
  type MergeProps as MergeIconProps,
};
